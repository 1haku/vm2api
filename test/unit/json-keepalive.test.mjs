import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  startJsonKeepalive,
  stopJsonKeepalive,
  abortJsonKeepalive,
  jsonResponseLogStatus,
} from '../../src/lib/http/json-keepalive.mjs'
import { createRespond } from '../../src/lib/http/respond.mjs'
import { runJsonKeepaliveProbe } from '../../src/lib/admin/json-keepalive-probe.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'

const { json } = createRespond({ rewrite: { enabled: false } })
async function serve(t, run) {
  const server = http.createServer((req, res) => {
    Promise.resolve(run(req, res)).catch((error) => {
      abortJsonKeepalive(res)
      res.destroy(error)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(r)
      }),
  )
  return 'http://127.0.0.1:' + server.address().port
}

test('delayed padding is real wire data and produces exactly one JSON message', async (t) => {
  const expected = { type: 'message', content: [{ type: 'text', text: 'hello' }] }
  let release
  const ready = new Promise((r) => {
    release = r
  })
  const url = await serve(t, async (req, res) => {
    startJsonKeepalive(req, res, { delayMs: 20, intervalMs: 10, maxDurationMs: 2000 })
    await ready
    json(res, 200, expected)
  })
  const response = await fetch(url)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/)
  assert.match(response.headers.get('cache-control'), /no-store, no-transform/)
  const reader = response.body.getReader()
  const first = await reader.read()
  const decoder = new TextDecoder()
  let text = decoder.decode(first.value)
  assert.match(text, /^\s+$/)
  await sleep(25)
  release()
  while (true) {
    const next = await reader.read()
    if (next.done) break
    text += decoder.decode(next.value)
  }
  assert.deepEqual(JSON.parse(text), expected)
  assert.doesNotMatch(text, /event:|data:/)
})

test('fast success and early denial retain ordinary JSON status and headers', async (t) => {
  const url = await serve(t, (req, res) => {
    startJsonKeepalive(req, res, { delayMs: 500, maxDurationMs: 2000 })
    const status = req.url === '/denied' ? 403 : 200
    json(res, status, status === 403 ? { error: { code: 'forbidden', details: { retryable: false } } } : { ok: true })
  })
  for (const [route, status] of [
    ['/', 200],
    ['/denied', 403],
  ]) {
    const res = await fetch(url + route)
    assert.equal(res.status, status)
    assert.equal(res.headers.get('x-kin-json-keepalive'), null)
    if (status === 403) assert.equal(res.headers.get('x-should-retry'), 'false')
    await res.json()
  }
})

for (const status of [429, 503, 504]) {
  test(`late ${status} aborts rather than masquerading as a successful JSON response`, async (t) => {
    let logged
    const url = await serve(t, async (req, res) => {
      startJsonKeepalive(req, res, { delayMs: 10, intervalMs: 10, maxDurationMs: 1000 })
      await sleep(80)
      json(res, status, { type: 'error', error: { message: 'simulated upstream failure' } })
      logged = jsonResponseLogStatus(res)
    })
    const res = await fetch(url)
    assert.equal(res.status, 200) // immutable once padding was sent
    await assert.rejects(res.json())
    assert.equal(logged, status)
  })
}

test('client cancellation stops padding and is logged as 499, not default HTTP 200', async (t) => {
  let closed
  const ended = new Promise((r) => {
    closed = r
  })
  const url = await serve(t, (req, res) => {
    const keepalive = startJsonKeepalive(req, res, { delayMs: 10, intervalMs: 10, maxDurationMs: 1000 })
    res.on('close', () => closed({ status: jsonResponseLogStatus(res, 'cancelled'), keepalive }))
  })
  const controller = new AbortController()
  const res = await fetch(url, { signal: controller.signal })
  await res.body.getReader().read()
  controller.abort()
  const result = await ended
  assert.equal(result.status, 499)
})

test('a bounded request deadline closes a stuck response and records 504', async (t) => {
  let logged
  const url = await serve(t, (req, res) => {
    startJsonKeepalive(req, res, { delayMs: 10, intervalMs: 10, maxDurationMs: 70 })
    res.on('close', () => {
      logged = jsonResponseLogStatus(res, 'cancelled')
    })
  })
  const res = await fetch(url)
  await assert.rejects(res.json())
  await sleep(10)
  assert.equal(logged, 504)
})

test('disabled keepalive produces no early response', async (t) => {
  assert.equal(jsonResponseLogStatus({ statusCode: 200 }, 'cancelled'), 200)
  const url = await serve(t, async (req, res) => {
    assert.equal(startJsonKeepalive(req, res, { delayMs: 0 }), null)
    await sleep(30)
    json(res, 200, { ok: true })
  })
  const res = await fetch(url)
  assert.equal(res.headers.get('x-kin-json-keepalive'), null)
  assert.deepEqual(await res.json(), { ok: true })
})

test('serialization failure is not recorded as HTTP 200 success', async (t) => {
  let logged
  const url = await serve(t, async (req, res) => {
    startJsonKeepalive(req, res, { delayMs: 10, maxDurationMs: 1000 })
    await sleep(60)
    const circular = {}
    circular.self = circular
    try {
      json(res, 200, circular)
    } catch {
      abortJsonKeepalive(res, 500)
      logged = jsonResponseLogStatus(res)
    }
  })
  const res = await fetch(url)
  await assert.rejects(res.json())
  assert.equal(logged, 500)
})

test('unexpected exceptions abort committed JSON and retain failure status', async (t) => {
  let logged
  const url = await serve(t, async (req, res) => {
    startJsonKeepalive(req, res, { delayMs: 10, maxDurationMs: 1000 })
    await sleep(60)
    abortJsonKeepalive(res, 500)
    stopJsonKeepalive(res)
    logged = jsonResponseLogStatus(res)
  })
  const res = await fetch(url)
  await assert.rejects(res.json())
  assert.equal(logged, 500)
})

test('public diagnostic requires admin plus a short-lived local enable file', async (t) => {
  const route = '/api/panel/diagnostics/json-keepalive'
  assert.equal(authorizePanelRoute('POST', route, 'admin').ok, true)
  for (const role of ['user', 'super']) assert.equal(authorizePanelRoute('POST', route, role).ok, false)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-json-probe-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const url = await serve(t, (req, res) =>
    runJsonKeepaliveProbe(req, res, { dataDir: root, json, scenario: 'early-error' }),
  )
  assert.equal((await fetch(url)).status, 404)
  fs.mkdirSync(path.join(root, 'run'))
  const flag = path.join(root, 'run', 'json-keepalive-probe.json')
  for (const until of [0, Date.now() + 3600_000]) {
    fs.writeFileSync(flag, JSON.stringify({ enabled_until: until }))
    assert.equal((await fetch(url)).status, 404)
  }
  fs.writeFileSync(flag, JSON.stringify({ enabled_until: Date.now() + 60_000 }))
  assert.equal((await fetch(url)).status, 503)
})

test('real aborted response retains wire headers in debug metadata', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-json-log-'))
  const store = new RequestLogStore({ dataDir: dir, mode: 'debug' })
  t.after(() => {
    store.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  let record
  const url = await serve(t, async (req, res) => {
    const ctx = store.start(req, { pathName: '/v1/messages' })
    store.tapResponse(ctx, res)
    startJsonKeepalive(req, res, { delayMs: 10, maxDurationMs: 1000 })
    await sleep(60)
    json(res, 503, { error: { message: 'simulated' } })
    store.finish(ctx, { status: jsonResponseLogStatus(res), final_state: 'incomplete' })
    record = store.getDebug(ctx.request_id)
  })
  const res = await fetch(url)
  await assert.rejects(res.json())
  assert.equal(record.status, 503)
  assert.equal(record.response.status, 200)
  assert.match(record.response.headers['content-type'], /application\/json/)
  assert.equal(record.response.headers['x-kin-json-keepalive'], '1')
})
