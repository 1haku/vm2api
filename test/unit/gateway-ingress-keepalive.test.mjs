import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createRespond, readBody } from '../../src/lib/http/respond.mjs'

const body = { model: 'claude-haiku-4-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] }

async function harness(t, { denyAuth = false, strict = false } = {}) {
  const cfg = {
    rewrite: { enabled: false },
    intercept: { rules: [] },
    distill: { enabled: false },
    limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 5000, stream_keepalive_ms: 20 },
    paths: {},
  }
  const respond = createRespond(cfg)
  const logs = [],
    runs = [],
    responses = new Map(),
    pending = new Set()
  const handler = createHandleProtocol({
    ...respond,
    readBody,
    cfg,
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    accountQuota: {},
    stickyRouter: {},
    groupsRepo: { rateMultiplier: () => 1 },
    getRoutingConfig: () => ({
      inference: { engine: 'go' },
      sticky: { enabled: false },
      compatibility: { claude_code_only: strict },
      failover: { queue_keepalive_delay_ms: 60 },
    }),
    requireAuth(req, res) {
      if (denyAuth) {
        respond.json(res, 401, { error: { code: 'invalid_api_key' } })
        return false
      }
      req.apiKeyKind = 'master'
      return true
    },
    requestLog: {
      start(req) {
        const ctx = { request_id: String(responses.size), t0: Date.now(), mode: 'normal' }
        responses.set(ctx.request_id, req.response)
        return ctx
      },
      finish(ctx, bag) {
        logs.push(bag)
      },
    },
    failoverRunner: {
      async run(opts) {
        const res = responses.get(opts.requestId)
        runs.push({ committed: res.headersSent })
        await sleep(20)
        return {
          ok: false,
          status: 503,
          code: 'no_available_accounts',
          message: 'fixture unavailable',
          finalState: 'exhausted',
        }
      },
    },
  })
  const server = http.createServer((req, res) => {
    req.response = res
    const work = handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages').catch((e) => {
      if (!res.headersSent && !res.destroyed) respond.json(res, 500, { error: { message: e.message } })
      else res.destroy()
    })
    pending.add(work)
    work.finally(() => pending.delete(work))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await Promise.all(pending)
    await new Promise((resolve) => server.close(resolve))
  })
  return { url: `http://127.0.0.1:${server.address().port}/v1/messages`, logs, runs }
}

async function upload(url, text, delay = 120, abort = false) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        'user-agent': 'test-client',
      },
    })
    req.on('error', (error) => (abort ? resolve(null) : reject(error)))
    req.on('response', (res) => {
      let data = ''
      res.on('data', (c) => {
        data += c
      })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }))
      res.on('error', reject)
    })
    req.write(text.slice(0, 2))
    setTimeout(() => (abort ? req.destroy() : req.end(text.slice(2))), delay)
  })
}

test('slow upload gets an immediate admitted SSE ping before scheduler work', async (t) => {
  const gw = await harness(t)
  const result = await upload(gw.url, JSON.stringify(body))
  assert.equal(gw.runs.length, 1)
  assert.equal(gw.runs[0].committed, true)
  assert.equal(result.status, 200)
  assert.match(result.headers['content-type'], /text\/event-stream/)
  assert.match(result.data, /^event: ping\n/)
  assert.ok(gw.logs[0].request_body_metrics.read_ms >= 70)
  assert.equal(gw.logs[0].request_body_metrics.complete, true)
})

test('slow invalid JSON, policy-denied and unauthenticated uploads keep real HTTP denials without a ping', async (t) => {
  for (const scenario of [
    { denyAuth: true, text: JSON.stringify(body), status: 401 },
    { text: '{ invalid json }', status: 400 },
    { strict: true, text: JSON.stringify(body), status: 403 },
  ]) {
    const gw = await harness(t, scenario)
    const result = await upload(gw.url, scenario.text)
    assert.equal(result.status, scenario.status)
    assert.doesNotMatch(result.data, /event: ping/)
    assert.equal(gw.runs.length, 0)
  }
})

test('non-streaming slow upload stays JSON without SSE commitment', async (t) => {
  const gw = await harness(t)
  const result = await upload(gw.url, JSON.stringify({ ...body, stream: false }))
  assert.equal(gw.runs[0].committed, false)
  assert.equal(result.status, 503)
  assert.match(result.headers['content-type'], /application\/json/)
  assert.doesNotMatch(result.data, /event: ping/)
})

test('aborted uploads log 499 and received bytes without scheduling', async (t) => {
  const gw = await harness(t)
  await upload(gw.url, JSON.stringify(body), 60, true)
  for (let i = 0; i < 50 && !gw.logs.length; i++) await sleep(10)
  assert.equal(gw.logs.length, 1)
  assert.equal(gw.logs[0].status, 499)
  assert.equal(gw.logs[0].final_state, 'cancelled')
  assert.equal(gw.logs[0].request_body_metrics.complete, false)
  assert.equal(gw.logs[0].request_body_metrics.received_bytes, 2)
  assert.equal(gw.runs.length, 0)
})
