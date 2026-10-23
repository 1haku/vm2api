import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

test('image permission is admin-managed, user-wide, covers Images and Responses, and revokes immediately', async () => {
  const gw = await startGateway()
  try {
    const users = []
    for (const username of ['image-alice', 'image-bob']) {
      const r = await api(gw, 'POST', '/api/panel/users', {
        body: { username, password: 'test-password-123', role: 'user' },
      })
      assert.equal(r.status, 201, r.text)
      users.push(r.json.data.item)
      assert.equal(r.json.data.item.image_generation_enabled, false)
    }
    const keys = []
    for (const u of [users[0], users[0], users[1]]) {
      const r = await api(gw, 'POST', '/api/panel/api-keys', {
        body: { user_id: u.id, name: 'image-key', category: 'oauth' },
      })
      assert.equal(r.status, 201, r.text)
      keys.push(r.json.item.key)
    }
    const routes = [
      ['/v1/images/generations', { model: 'gpt-image-2.5-flare', prompt: 'x' }],
      ['/v1/images/edits', { model: 'gpt-image-2.5-flare', prompt: 'x' }],
      ['/v1/responses', { model: 'gpt-6.1-sol', input: 'x', tools: [{ type: 'image_generation' }] }],
    ]
    const call = (key, [path, body]) => api(gw, 'POST', path, { headers: { authorization: 'Bearer ' + key }, body })
    for (const key of keys)
      for (const route of routes) {
        const r = await call(key, route)
        assert.equal(r.status, 403, r.text)
        assert.equal(r.json.error.code, 'image_generation_disabled')
      }
    const login = await api(gw, 'POST', '/api/panel/login', {
      body: { username: 'image-alice', password: 'test-password-123' },
    })
    const denied = await api(gw, 'PATCH', '/api/panel/users/' + users[0].id, {
      headers: { authorization: 'Bearer ' + login.json.token },
      body: { image_generation_enabled: true },
    })
    assert.equal(denied.status, 403)
    const enabled = await api(gw, 'PATCH', '/api/panel/users/' + users[0].id, {
      body: { image_generation_enabled: true },
    })
    assert.equal(enabled.status, 200, enabled.text)
    assert.equal(enabled.json.data.item.image_generation_enabled, true)
    // No GPT fixture slots: reaching slot/model validation is sufficient; never call a real image provider.
    for (const key of keys.slice(0, 2))
      for (const route of routes) {
        const r = await call(key, route)
        assert.notEqual(r.json?.error?.code, 'image_generation_disabled', r.text)
      }
    assert.equal((await call(keys[2], routes[0])).json.error.code, 'image_generation_disabled')
    const invalid = await api(gw, 'PATCH', '/api/panel/users/' + users[0].id, {
      body: { image_generation_enabled: 'true' },
    })
    assert.equal(invalid.status, 400)
    const revoked = await api(gw, 'PATCH', '/api/panel/users/' + users[0].id, {
      body: { image_generation_enabled: false },
    })
    assert.equal(revoked.status, 200)
    for (const key of keys.slice(0, 2))
      assert.equal((await call(key, routes[2])).json.error.code, 'image_generation_disabled')
  } finally {
    await gw.stop()
  }
})
