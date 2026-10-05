import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { SubscriptionsRepo } from '../../src/lib/db/repos/subscriptions-repo.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createRespond, readBody } from '../../src/lib/http/respond.mjs'

test('stream disconnect and upstream exceptions release exactly the caller claim and subscription reservation', {
  timeout: 15000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'limits-stream-'))
  const db = createDatabase({ dataDir: path.join(root, 'data') })
  const store = new ApiKeyStore({ db }),
    users = new PanelUserStore({ db }),
    subscriptions = new SubscriptionsRepo(db)
  const user = users.create({ username: 'stream-user', password: 'test-password', concurrency: 1 })
  db.prepare("INSERT INTO vms(id,name,vm_json) VALUES('slot','slot','{}')").run()
  const plan = subscriptions.savePlan(
    { name: 'stream', vm_ids: ['slot'], daily_limit_usd: 30, subscription_concurrency: 2 },
    'admin',
  )
  subscriptions.assign({ group_id: plan.id, user_ids: [user.id] }, 'admin')
  const keys = [0, 1].map((i) =>
    store.create({ name: 'key-' + i, user_id: user.id, group_id: plan.id, max_concurrency: 0 }),
  )
  const routing = {
    inference: { engine: 'go' },
    sticky: { enabled: false },
    compatibility: { persona_preset: 'official_full' },
  }
  const routingPath = path.join(root, 'routing.json')
  fs.writeFileSync(routingPath, JSON.stringify(routing))
  const cfg = {
    rewrite: { enabled: false },
    intercept: { rules: [] },
    distill: { enabled: false },
    limits: { max_body_bytes: 1048576, upstream_timeout_ms: 5000 },
    paths: { project: root, data: path.join(root, 'data') },
  }
  const respond = createRespond(cfg),
    entries = [],
    pending = new Set()
  let scenario = 'hold'
  const handler = createHandleProtocol({
    ...respond,
    readBody,
    cfg,
    apiKeyStore: store,
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfigPath: routingPath,
    routingConfig: routing,
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    accountQuota: {},
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    requireAuth(req) {
      const result = store.authenticate(req.headers.authorization?.slice(7))
      assert.equal(result.ok, true)
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = result.record
      return true
    },
    requestLog: {
      start(req) {
        const ctx = { request_id: crypto.randomUUID() }
        entries.push({ ctx, res: req.response })
        return ctx
      },
      finish(ctx, bag) {
        subscriptions.settle(ctx.request_id, bag.subscription_id, 0)
      },
    },
    failoverRunner: {
      async run(opts) {
        if (scenario === 'throw') throw Error('fixture upstream failure')
        const res = entries.find((e) => e.ctx.request_id === opts.requestId).res
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"ready":true}\n\n')
        await new Promise((resolve) => {
          if (opts.signal.aborted) resolve()
          else opts.signal.addEventListener('abort', resolve, { once: true })
        })
        throw Error('fixture upstream aborted')
      },
    },
  })
  const server = http.createServer((req, res) => {
    req.response = res
    const work = handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages').catch(() => {
      if (!res.destroyed) {
        if (!res.headersSent) res.writeHead(502)
        res.end()
      }
    })
    pending.add(work)
    work.finally(() => pending.delete(work))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/v1/messages`
  const call = (key, signal) =>
    fetch(url, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
  const active = () => db.prepare('SELECT COUNT(*) AS n FROM custom_subscription_reservations').get().n
  try {
    const abort = new AbortController(),
      response = await call(keys[0], abort.signal)
    assert.equal(response.status, 200)
    assert.equal(active(), 1)
    const blocked = await call(keys[1])
    assert.equal(blocked.status, 429)
    assert.equal((await blocked.json()).error.code, 'user_concurrency_limit')
    assert.equal(active(), 1, 'blocked request rolled back only its own reservation')
    const completed = [...pending]
    abort.abort()
    await Promise.all(completed)
    assert.equal(active(), 0)
    assert.equal(store.userInflight.size, 0)
    assert.equal(store.claims.size, 0)
    scenario = 'throw'
    const failed = await call(keys[1])
    assert.equal(failed.status, 502)
    await failed.text()
    await Promise.all([...pending])
    assert.equal(active(), 0)
    assert.equal(store.userInflight.size, 0)
    assert.equal(store.claims.size, 0)
  } finally {
    server.closeAllConnections()
    await Promise.all([...pending])
    await new Promise((resolve) => server.close(resolve))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
