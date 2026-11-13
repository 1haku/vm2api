import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { readBody, readRawBody, requestBodyMetrics } from '../../src/lib/http/respond.mjs'

const metricKeys = ['complete', 'error_code', 'expected_bytes', 'parse_ms', 'read_ms', 'received_bytes']
const readers = [readBody, readRawBody]
const outcome = (promise) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  )

function streamRequest(headers = {}) {
  const req = new PassThrough()
  req.headers = headers
  return req
}

function assertMetrics(req, expected) {
  const metrics = requestBodyMetrics(req)
  assert.deepEqual(Object.keys(metrics).sort(), metricKeys)
  for (const key of ['read_ms', 'parse_ms']) {
    assert.ok(Number.isFinite(metrics[key]) && metrics[key] >= 0, `${key} must be a nonnegative duration`)
  }
  for (const [key, value] of Object.entries(expected)) assert.equal(metrics[key], value, key)
  return metrics
}

async function httpRequest(t, reader, headers = {}, maxBytes = 1024) {
  const accepted = Promise.withResolvers()
  const server = http.createServer((req, res) => {
    const closed = new Promise((resolve) => req.once('close', resolve))
    const result = outcome(reader(req, maxBytes))
    result.then(({ error }) => {
      if (!res.destroyed) {
        res.statusCode = error?.status || 200
        res.end()
      }
    })
    accepted.resolve({ req, result, closed })
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const client = http.request({
    host: '127.0.0.1',
    port: server.address().port,
    method: 'POST',
    headers,
    agent: false,
  })
  t.after(() => client.destroy())
  const response = new Promise((resolve) => {
    client.once('response', (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    client.once('error', resolve)
  })
  client.flushHeaders()
  return { client, response, ...(await accepted.promise) }
}

test('snapshots are absent before collection, initialized synchronously and detached from internal state', async () => {
  const req = streamRequest({ 'content-length': '2', authorization: 'HEADER_SECRET' })
  assert.equal(requestBodyMetrics(req), null)
  assert.equal(requestBodyMetrics({}), null)
  assert.equal(requestBodyMetrics(null), null)
  const body = readBody(req, 2)
  const snapshot = assertMetrics(req, {
    expected_bytes: 2,
    received_bytes: 0,
    parse_ms: 0,
    complete: false,
    error_code: null,
  })
  snapshot.received_bytes = 999
  snapshot.error_code = 'tampered'
  snapshot.headers = req.headers
  req.end('{}')
  assert.deepEqual(await body, {})
  const final = assertMetrics(req, { expected_bytes: 2, received_bytes: 2, complete: true, error_code: null })
  assert.ok(final.parse_ms > 0)
  assert.equal(JSON.stringify(final).includes('HEADER_SECRET'), false)
})

test('content-length accepts only decimal safe integers and does not change body acceptance', async () => {
  const cases = [
    ['0', 0],
    ['0002', 2],
    ['42', 42],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    [undefined, null],
    ['', null],
    ['-1', null],
    ['+1', null],
    ['1.5', null],
    ['1e3', null],
    ['0x10', null],
    ['12x', null],
    ['1, 1', null],
    [['1'], null],
    [2, null],
    ['Infinity', null],
    ['9007199254740992', null],
    [' 2 ', null],
    ['2\n', null],
  ]
  for (const [header, expected] of cases) {
    const req = streamRequest({ 'content-length': header })
    const body = readRawBody(req, 2)
    assert.equal(requestBodyMetrics(req).expected_bytes, expected, `header ${JSON.stringify(header)}`)
    req.end('{}')
    assert.deepEqual(await body, Buffer.from('{}'))
    assertMetrics(req, { expected_bytes: expected, received_bytes: 2, parse_ms: 0, complete: true, error_code: null })
  }
})

for (const reader of readers) {
  test(`${reader.name}: empty bodies retain their original return values`, async () => {
    const req = streamRequest({ 'content-length': '0' })
    const body = reader(req, 0)
    req.end()
    assert.deepEqual(await body, reader === readBody ? {} : Buffer.alloc(0))
    assertMetrics(req, { expected_bytes: 0, received_bytes: 0, parse_ms: 0, complete: true, error_code: null })
  })

  for (const chunked of [false, true]) {
    test(`${reader.name}: real HTTP ${chunked ? 'chunked' : 'content-length'} upload exposes incremental metrics`, {
      timeout: 5000,
    }, async (t) => {
      const payload = Buffer.from('{"message":"慢🚀BODY_SECRET"}')
      const split = Buffer.byteLength('{"message":"') + 1 // Split inside a UTF-8 character.
      const headers = { authorization: 'HEADER_SECRET' }
      if (!chunked) headers['content-length'] = String(payload.length)
      const { client, req, result, response } = await httpRequest(t, reader, headers)
      const initial = assertMetrics(req, {
        expected_bytes: chunked ? null : payload.length,
        received_bytes: 0,
        parse_ms: 0,
        complete: false,
        error_code: null,
      })
      const data = once(req, 'data')
      client.write(payload.subarray(0, split))
      await data
      const partial = assertMetrics(req, { received_bytes: split, parse_ms: 0, complete: false, error_code: null })
      await delay(40)
      const waiting = requestBodyMetrics(req)
      assert.ok(waiting.read_ms - partial.read_ms >= 20, 'read time includes waiting between chunks')
      client.end(payload.subarray(split))
      const { value, error } = await result
      assert.equal(error, undefined)
      assert.deepEqual(value, reader === readBody ? { message: '慢🚀BODY_SECRET' } : payload)
      assert.equal(await response, 200)
      const final = assertMetrics(req, { received_bytes: payload.length, complete: true, error_code: null })
      assert.ok(final.read_ms >= waiting.read_ms)
      if (reader === readBody) assert.ok(final.parse_ms > 0)
      else assert.equal(final.parse_ms, 0)
      assert.equal(initial.received_bytes, 0, 'old snapshots do not change as chunks arrive')
      assert.equal(partial.complete, false)
      await delay(10)
      assert.deepEqual(requestBodyMetrics(req), final, 'durations stop changing after completion')
      assert.doesNotMatch(JSON.stringify(final), /BODY_SECRET|HEADER_SECRET/)
    })
  }

  test(`${reader.name}: real HTTP client cancellation rejects with readable partial metrics`, {
    timeout: 5000,
  }, async (t) => {
    const { client, req, result, closed } = await httpRequest(t, reader, { 'content-length': '100' })
    const data = once(req, 'data')
    client.write('part')
    await data
    await delay(30)
    client.destroy()
    const { error } = await result
    assert.equal(error.status, 400)
    assert.equal(error.body.error.code, 'request_aborted')
    await closed // IncomingMessage emits error after aborted; it must remain handled.
    const metrics = assertMetrics(req, {
      expected_bytes: 100,
      received_bytes: 4,
      parse_ms: 0,
      complete: false,
      error_code: 'request_aborted',
    })
    assert.ok(metrics.read_ms >= 20)
    await delay(10)
    assert.deepEqual(requestBodyMetrics(req), metrics)
  })

  test(`${reader.name}: stream failures retain the original error shape without leaking error text`, async () => {
    const req = streamRequest()
    const closed = new Promise((resolve) => req.once('close', resolve))
    const errors = []
    req.on('error', (error) => errors.push(error))
    const result = outcome(reader(req, 100))
    req.write('partial')
    await delay(30)
    req.destroy(new Error('PRIVATE_STREAM_ERROR'))
    const { error } = await result
    await closed
    assert.equal(error.status, 400)
    assert.equal(error.body.error.code, 'request_stream_error')
    assert.equal(error.body.error.message, 'PRIVATE_STREAM_ERROR')
    assert.equal(errors.length, 1, 'other error observers still receive the error')
    const metrics = assertMetrics(req, {
      expected_bytes: null,
      received_bytes: 7,
      parse_ms: 0,
      complete: false,
      error_code: 'request_stream_error',
    })
    assert.ok(metrics.read_ms >= 20)
    assert.doesNotMatch(JSON.stringify(metrics), /PRIVATE_STREAM_ERROR|partial/)
  })

  test(`${reader.name}: aborted alone settles and a later error cannot replace its metrics or go unhandled`, async () => {
    const req = streamRequest()
    const result = outcome(reader(req, 100))
    req.write('abc')
    req.emit('aborted')
    const { error } = await result
    assert.equal(error.body.error.code, 'request_aborted')
    const metrics = assertMetrics(req, {
      received_bytes: 3,
      parse_ms: 0,
      complete: false,
      error_code: 'request_aborted',
    })
    await delay(10)
    assert.doesNotThrow(() => req.emit('error', new Error('late ECONNRESET')))
    assert.deepEqual(requestBodyMetrics(req), metrics)
    req.destroy()
  })

  test(`${reader.name}: 413 freezes metrics through same-turn aborted and draining, preserving observers`, async () => {
    const req = streamRequest({ 'content-length': '8' })
    const chunks = []
    const observer = (chunk) => chunks.push(chunk)
    req.on('data', observer)
    const ended = once(req, 'end')
    const result = outcome(reader(req, 4))
    req.write('1234')
    assertMetrics(req, { received_bytes: 4, complete: false, error_code: null })
    await delay(30)
    req.write('5')
    req.emit('aborted')
    const { error } = await result
    assert.equal(error.status, 413)
    assert.equal(error.body.error.code, 'body_too_large')
    assert.deepEqual(error.body.error.details, { max_bytes: 4, received: 5 })
    const rejected = assertMetrics(req, {
      expected_bytes: 8,
      received_bytes: 5,
      parse_ms: 0,
      complete: false,
      error_code: 'body_too_large',
    })
    assert.ok(rejected.read_ms >= 20)
    assert.ok(req.listeners('data').includes(observer))
    req.write('67')
    req.end('8')
    await ended
    assert.equal(Buffer.concat(chunks).toString(), '12345678')
    assert.deepEqual(requestBodyMetrics(req), rejected, 'drained bytes and end cannot change a failed snapshot')
    assert.doesNotThrow(() => req.emit('error', new Error('late stream error')))
    req.emit('aborted')
    assert.deepEqual(requestBodyMetrics(req), rejected)
  })

  test(`${reader.name}: real HTTP oversized uploads return 413`, { timeout: 5000 }, async (t) => {
    const { client, req, result, response } = await httpRequest(t, reader, { 'content-length': '8' }, 4)
    const data = once(req, 'data')
    client.write('1234')
    await data
    client.end('5678')
    const { error } = await result
    assert.equal(error.status, 413)
    assert.equal(error.body.error.code, 'body_too_large')
    assert.equal(await response, 413)
    assertMetrics(req, { expected_bytes: 8, received_bytes: 8, parse_ms: 0, error_code: 'body_too_large' })
  })
}

test('real HTTP invalid JSON records parsing failure after a complete read without exposing content', {
  timeout: 5000,
}, async (t) => {
  const payload = '{"message":"BODY_SECRET",broken}'
  const { client, req, result, response } = await httpRequest(t, readBody, {
    'content-length': String(Buffer.byteLength(payload)),
    authorization: 'HEADER_SECRET',
  })
  client.end(payload)
  const { error } = await result
  assert.equal(error.status, 400)
  assert.equal(error.body.error.code, 'invalid_json')
  assert.match(error.body.error.message, /^Request body is not valid JSON:/)
  assert.equal(typeof error.body.error.details.parse_error, 'string')
  assert.equal(await response, 400)
  const metrics = assertMetrics(req, {
    expected_bytes: Buffer.byteLength(payload),
    received_bytes: Buffer.byteLength(payload),
    complete: true,
    error_code: 'invalid_json',
  })
  assert.ok(metrics.parse_ms > 0)
  assert.doesNotMatch(JSON.stringify(metrics), /BODY_SECRET|HEADER_SECRET|parse_error|message/)
  await delay(10)
  assert.deepEqual(requestBodyMetrics(req), metrics)
})

test('raw binary and JSON primitives retain their return types and metrics stay isolated per request', async () => {
  const raw = streamRequest()
  const json = streamRequest()
  const bytes = Buffer.from([0xff, 0x00, 0x7b, 0x01])
  const binary = readRawBody(raw, 4)
  const parsed = readBody(json, 4)
  raw.end(bytes)
  json.end('null')
  assert.deepEqual(await binary, bytes)
  assert.equal(await parsed, null)
  assertMetrics(raw, { received_bytes: 4, parse_ms: 0, complete: true, error_code: null })
  assertMetrics(json, { received_bytes: 4, complete: true, error_code: null })
  assert.ok(requestBodyMetrics(json).parse_ms > 0)
})
