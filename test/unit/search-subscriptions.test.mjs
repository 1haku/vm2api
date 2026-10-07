import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { SubscriptionsRepo } from '../../src/lib/db/repos/subscriptions-repo.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

test('Codex search honors subscription routing, revocation, quota, cross-key limits and logging', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-subscriptions-'))
  const db = openDatabase({ dataDir: path.join(root, 'data') })
  t.after(() => {
    closeDatabase()
    resetOpenAIAccountRuntime()
    fs.rmSync(root, { recursive: true, force: true })
  })
  resetOpenAIAccountRuntime()
  for (const id of ['assigned', 'foreign']) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'vms', id + '.json'),
      JSON.stringify({ id, name: id, platform: 'openai', family: 'codex', status: 'running', schedulable: true }),
    )
    fs.writeFileSync(
      path.join(root, 'vms', id, 'codex-credentials.json'),
      JSON.stringify({ accounts: [{ id: id + '-account', access_token: 'fixture-token', chatgpt_account_id: id }] }),
    )
    db.prepare('INSERT INTO vms(id,name,vm_json) VALUES(?,?,?)').run(id, id, '{}')
  }
  const users = new PanelUserStore({ db }),
    keys = new ApiKeyStore({ db }),
    subs = new SubscriptionsRepo(db)
  const user = users.create({ username: 'search-user', password: 'fixture-password', concurrency: 1, rpm_limit: 0 })
  const plan = subs.savePlan(
    { name: 'Search plan', platform: 'openai', vm_ids: ['assigned'], daily_limit_usd: 30, subscription_concurrency: 2 },
    'admin',
  )
  const [subscription] = subs.assign({ group_id: plan.id, user_ids: [user.id] }, 'admin')
  const key1 = keys.create({ name: 'search-one', user_id: user.id, group_id: plan.id, max_concurrency: 0, rpm: 0 })
  const key2 = keys.create({ name: 'search-two', user_id: user.id, group_id: plan.id, max_concurrency: 0, rpm: 0 })
  const logs = new RequestLogStore({ db, mode: 'off' })
  const handler = createHandleProtocol({
    cfg: { paths: { project: root, data: path.join(root, 'data') }, limits: { max_body_bytes: 1048576 } },
    json: (res, status, body) => {
      res.statusCode = status
      res.body = body
      return body
    },
    readBody: async (req) => req.body,
    requireAuth: (req) => {
      const auth = keys.authenticate(req.headers.authorization.slice(7))
      assert.equal(auth.ok, true)
      req.apiKeyKind = 'managed'
      req.apiKeyRecord = auth.record
      return true
    },
    apiKeyStore: keys,
    requestLog: logs,
    stats: { requests: 0, errors: 0, by_route: {} },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfig: {},
  })
  const call = async (key = key1) => {
    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: '/v1/alpha/search',
      headers: {
        authorization: `Bearer ${key.key}`,
        'user-agent': 'codex_exec/0.160.1',
        'x-request-id': 'caller-reused',
        'x-kin-log': 'off',
      },
      body: { model: 'gpt-6.1-sol', commands: { search_query: [{ q: 'fixture' }] } },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const res = Object.assign(new EventEmitter(), { statusCode: 200, setHeader() {} })
    await handler.handleSearch(req, res, req.url)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_subscription_reservations').get().n, 0)
    return res
  }
  // With no exit configured, an allowed call stops locally, never contacting a provider.
  const first = await call()
  assert.equal(first.statusCode, 502)
  assert.equal(first.body.error.code, 'proxy_required')
  const row = db.prepare('SELECT * FROM usage_logs ORDER BY created_at DESC LIMIT 1').get()
  assert.equal(row.vm_id, 'assigned')
  assert.equal(row.user_id, user.id)
  assert.equal(row.subscription_id, subscription)
  assert.notEqual(row.request_id, 'caller-reused')
  assert.equal(keys.claims.size, 0)
  assert.equal(keys.getById(key1.id).quota_requests_used, 1)
  const claim = keys.acquire(key1)
  assert.equal((await call(key2)).body.error.code, 'user_concurrency_limit')
  assert.equal(keys.claims.size, 1)
  claim.release()
  users.update(user.id, { rpm_limit: 1 })
  assert.equal((await call(key2)).body.error.code, 'user_rpm_limit')
  users.update(user.id, { rpm_limit: 0 })
  subs.savePlan({ group_rpm_limit: 1 }, 'admin', plan.id)
  assert.equal((await call(key2)).body.error.code, 'group_rpm_limit')
  subs.savePlan({ group_rpm_limit: 0 }, 'admin', plan.id)
  subs.update(subscription, { status: 'revoked' }, 'admin')
  assert.equal((await call()).body.error.code, 'subscription_inactive')
  subs.assign({ group_id: plan.id, user_ids: [user.id] }, 'admin')
  subs.settle('quota-full', subscription, 30)
  assert.equal((await call()).body.error.code, 'subscription_quota')
  assert.equal(keys.claims.size, 0)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM usage_logs WHERE vm_id='foreign'").get().n, 0)
})
