import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

test('public health checks expose only liveness and root redirects to login', async () => {
  const gw = await startGateway()
  try {
    for (const method of ['GET', 'HEAD']) {
      const root = await fetch(gw.baseUrl + '/?redirect=https://example.invalid', { method, redirect: 'manual' })
      assert.equal(root.status, 302)
      assert.equal(root.headers.get('location'), '/console/#/login')
      assert.equal(root.headers.get('cache-control'), 'no-store')
      assert.equal(await root.text(), '')
      for (const route of ['/health', '/healthz']) {
        const response = await fetch(gw.baseUrl + route, { method })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('cache-control'), 'no-store')
        if (method === 'HEAD') assert.equal(await response.text(), '')
        else assert.deepEqual(await response.json(), { status: 'ok' })
      }
    }
    const authenticatedHealth = await api(gw, 'GET', '/health')
    assert.deepEqual(authenticatedHealth.json, { status: 'ok' })
  } finally {
    await gw.stop()
  }
})

test('detailed service status and metadata require an administrator, not a client key', async () => {
  const gw = await startGateway()
  try {
    const routes = ['/api/panel/service-status', '/v1/meta']
    const login = await api(gw, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
    assert.equal(login.status, 200, login.text)
    const adminToken = login.json.token
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const deniedHeaders = [{}, { authorization: 'Bearer invalid-token' }]
    for (const role of ['user', 'super']) {
      const username = `metadata-${role}`
      const created = await api(gw, 'POST', '/api/panel/users', {
        body: { username, password: 'test-password-123', role },
      })
      assert.equal(created.status, 201, created.text)
      const session = await api(gw, 'POST', '/api/panel/login', { body: { username, password: 'test-password-123' } })
      assert.equal(session.status, 200, session.text)
      deniedHeaders.push({ authorization: `Bearer ${session.json.token}` })
      deniedHeaders.push({ cookie: session.headers.get('set-cookie').split(';')[0] })
    }
    // Even a managed key owned by admin must not gain panel metadata privileges.
    const key = await api(gw, 'POST', '/api/panel/api-keys', { body: { name: 'metadata-client-key' } })
    assert.equal(key.status, 201, key.text)
    deniedHeaders.push({ authorization: `Bearer ${key.json.item.key}` })
    for (const route of routes) {
      for (const method of ['GET', 'HEAD']) {
        for (const [index, headers] of deniedHeaders.entries()) {
          const response = await fetch(gw.baseUrl + route, { method, headers })
          assert.equal(response.status, index < 2 ? 401 : 403, `${method} ${route} denied credential ${index}`)
          assert.equal(response.headers.get('cache-control'), 'no-store')
          const text = await response.text()
          assert.doesNotMatch(text, /active_vm|base_url|capabilities|health_probe|vm-sim-01/)
        }
        for (const headers of [{ authorization: `Bearer ${adminToken}` }, { cookie }]) {
          const response = await fetch(gw.baseUrl + route, { method, headers })
          assert.equal(response.status, 200, `${method} ${route} admin`)
          assert.equal(response.headers.get('cache-control'), 'no-store')
          if (method === 'HEAD') assert.equal(await response.text(), '')
          else assert.ok((await response.json()).capabilities)
        }
      }
      assert.equal((await api(gw, 'GET', route)).status, 200, 'master key retains metadata access')
    }
    const protocol = await fetch(gw.baseUrl + '/v1/models', { headers: { authorization: `Bearer ${adminToken}` } })
    assert.equal(protocol.status, 403, 'metadata session exception must not authorize inference endpoints')
  } finally {
    await gw.stop()
  }
})

test('administrator service status retains honest capabilities', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'GET', '/api/panel/service-status')
    assert.equal(r.status, 200)
    assert.equal(r.json.status, 'ok')
    assert.equal(r.json.capabilities.workspace_default, 'client')
    assert.equal(r.json.capabilities.client_tools, true)
    assert.equal(r.json.capabilities.multi_turn_native, true)
    assert.equal(r.json.capabilities.worker, 'go-slot-worker')
    assert.equal(r.json.capabilities.forward_default, 'relay')
    assert.match(r.json.limitations.forward, /Rust kernel/i)
    assert.match(r.json.limitations.oauth, /sole refresh (owner|manager)/i)
    assert.equal(r.json.active_vm, 'vm-sim-01')
  } finally {
    await gw.stop()
  }
})

test('GET /v1/models is harvested from mock catalog strings', async () => {
  const gw = await startGateway()
  try {
    const r = await api(gw, 'GET', '/v1/models')
    assert.equal(r.status, 200)
    const ids = (r.json.data || r.json.models || []).map((m) => m.id || m)
    assert.ok(ids.includes('claude-haiku-4-5-20251001'), JSON.stringify(ids))
  } finally {
    await gw.stop()
  }
})

test('missing API key → 401', async () => {
  const gw = await startGateway()
  try {
    const res = await fetch(gw.baseUrl + '/v1/models')
    assert.equal(res.status, 401)
  } finally {
    await gw.stop()
  }
})
