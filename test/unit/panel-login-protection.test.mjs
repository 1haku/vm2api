import test from 'node:test'
import assert from 'node:assert/strict'
import { createPanelLoginProtection } from '../../src/lib/admin/panel-login-protection.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const env = {
  TURNSTILE_ENABLED: '1',
  TURNSTILE_SITE_KEY: 'public-test-key',
  TURNSTILE_SECRET: 'private-test-secret',
  TURNSTILE_HOSTNAMES: 'panel.example.com',
}
const req = { socket: { remoteAddress: '192.168.1.1' }, headers: {} }
const body = { username: 'admin', password: 'unused', 'cf-turnstile-response': 'one-use-token' }
const verified = { success: true, action: 'login', hostname: 'panel.example.com' }
const reply = (result) => async () => ({ ok: true, json: async () => result })

test('public configuration never exposes secret and disabled mode needs no network', async () => {
  const gate = createPanelLoginProtection({
    env,
    fetchImpl: () => {
      throw new Error('unexpected')
    },
  })
  assert.deepEqual(gate.publicConfig(), {
    enabled: true,
    ready: true,
    sitekey: env.TURNSTILE_SITE_KEY,
    hostnames: ['panel.example.com'],
  })
  const disabled = createPanelLoginProtection({
    env: {},
    fetchImpl: () => {
      throw new Error('unexpected')
    },
  })
  assert.equal(await disabled.check(req, {}), null)
})

test('tokens required even with spoofed local Host and forwarding headers', async () => {
  let called = false
  const gate = createPanelLoginProtection({
    env,
    fetchImpl: () => {
      called = true
    },
  })
  for (const token of [undefined, '', ' ', 4, 'a'.repeat(2049)]) {
    const r = await gate.check(
      { ...req, headers: { host: 'localhost', 'x-forwarded-for': '127.0.0.1' } },
      { ...body, 'cf-turnstile-response': token },
    )
    assert.equal(r.status, 403)
  }
  assert.equal(called, false)
})

test('canonical Siteverify request keeps secret server-side and checks exact result', async () => {
  const gate = createPanelLoginProtection({
    env,
    fetchImpl: async (url, opts) => {
      assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
      assert.equal(opts.body.get('secret'), env.TURNSTILE_SECRET)
      assert.equal(opts.body.get('response'), body['cf-turnstile-response'])
      assert.equal(opts.body.has('remoteip'), false)
      assert.ok(opts.signal)
      return { ok: true, json: async () => verified }
    },
  })
  assert.equal(await gate.check(req, body), null)
})

test('expired/replayed token, wrong action/hostname and truthy non-boolean success fail closed', async () => {
  for (const result of [
    null,
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { ...verified, action: 'signup' },
    { ...verified, hostname: 'evil.example.com' },
    { ...verified, hostname: 'panel.example.com.evil.test' },
    { ...verified, success: 'true' },
  ]) {
    const gate = createPanelLoginProtection({ env, fetchImpl: reply(result) })
    assert.equal((await gate.check(req, body)).status, 403)
  }
})

test('timeout, invalid JSON, HTTP failure and missing configuration fail closed', async () => {
  for (const fetchImpl of [
    async () => {
      throw new Error('timeout')
    },
    async () => ({ ok: false }),
    async () => ({
      ok: true,
      json: async () => {
        throw new Error('bad json')
      },
    }),
  ]) {
    assert.equal((await createPanelLoginProtection({ env, fetchImpl }).check(req, body)).status, 503)
  }
  for (const patch of [
    { TURNSTILE_SECRET: '' },
    { TURNSTILE_SITE_KEY: '' },
    { TURNSTILE_HOSTNAMES: '' },
    { TURNSTILE_HOSTNAMES: 'https://example.com' },
  ]) {
    assert.equal(
      (await createPanelLoginProtection({ env: { ...env, ...patch }, fetchImpl: reply(verified) }).check(req, body))
        .status,
      503,
    )
  }
})

test('account and socket limits cannot be bypassed by forwarding headers or case; windows expire', async () => {
  let time = 0
  const gate = createPanelLoginProtection({ env: {}, now: () => time })
  for (let i = 0; i < 10; i++) assert.equal(await gate.check(req, { username: 'ADMIN' }), null)
  assert.equal(
    (await gate.check({ ...req, headers: { 'x-forwarded-for': '8.8.8.8' } }, { username: ' admin ' })).status,
    429,
  )
  assert.equal(await gate.check(req, { username: 'other' }), null)
  time = 600_001
  assert.equal(await gate.check(req, { username: 'admin' }), null)
  for (let i = 0; i < 59; i++) assert.equal(await gate.check(req, { username: 'name' + i }), null)
  assert.equal((await gate.check(req, { username: 'another' })).status, 429)
})

test('login route gates password authentication, creates no session on rejection and rejects replay', async () => {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  const oldAdmin = process.env.KIN_ADMIN_PASSWORD
  Object.assign(process.env, env)
  process.env.KIN_ADMIN_PASSWORD = ''
  let response,
    calls = 0,
    input = { ...body }
  const headers = {}
  const res = {
    setHeader: (k, v) => {
      headers[k] = v
    },
  }
  const handler = createPanelHandler({
    cfg: { paths: { project: process.cwd() } },
    readBody: async () => input,
    json: (_r, status, payload) => {
      response = { status, payload }
    },
    turnstileFetch: async () => ({
      ok: true,
      json: async () => (++calls === 1 ? verified : { success: false, 'error-codes': ['timeout-or-duplicate'] }),
    }),
  })
  const request = { ...req, method: 'POST' }
  try {
    input = { username: 'nobody', password: 'wrong' }
    await handler(request, res, new URL('http://localhost/api/panel/login'))
    assert.equal(response.status, 403)
    assert.equal(calls, 0)
    input = { ...body }
    await handler(request, res, new URL('http://localhost/api/panel/login'))
    assert.equal(response.status, 401) // Verification passed; existing password check ran.
    await handler(request, res, new URL('http://localhost/api/panel/login'))
    assert.equal(response.status, 403)
    assert.equal(headers['Set-Cookie'], undefined)
    assert.equal(headers['Cache-Control'], 'no-store')
    await handler({ ...req, method: 'GET' }, res, new URL('http://localhost/api/panel/login-config'))
    assert.equal(response.status, 200)
    assert.equal(JSON.stringify(response.payload).includes(env.TURNSTILE_SECRET), false)
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (oldAdmin === undefined) delete process.env.KIN_ADMIN_PASSWORD
    else process.env.KIN_ADMIN_PASSWORD = oldAdmin
  }
})
