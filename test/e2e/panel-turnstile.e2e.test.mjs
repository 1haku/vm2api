import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

test('enabled login protection is mandatory while health, existing master auth and model API remain independent', async () => {
  const gw = await startGateway({
    env: {
      TURNSTILE_ENABLED: '1',
      TURNSTILE_SITE_KEY: 'site-public',
      TURNSTILE_SECRET: 'test-only',
      TURNSTILE_HOSTNAMES: 'panel.example.com',
    },
  })
  try {
    const config = await fetch(gw.baseUrl + '/api/panel/login-config')
    assert.equal(config.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await config.json(), {
      enabled: true,
      ready: true,
      sitekey: 'site-public',
      hostnames: ['panel.example.com'],
    })
    const denied = await fetch(gw.baseUrl + '/api/panel/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1', host: 'localhost' },
      body: JSON.stringify({ username: 'admin', password: 'testpass' }),
    })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('set-cookie'), null)
    assert.equal((await denied.json()).error.code, 'turnstile_required')
    assert.equal((await api(gw, 'GET', '/api/panel/me')).status, 200)
    assert.equal((await api(gw, 'GET', '/v1/models')).status, 200)
    assert.equal((await fetch(gw.baseUrl + '/health')).status, 200)
  } finally {
    await gw.stop()
  }
})
