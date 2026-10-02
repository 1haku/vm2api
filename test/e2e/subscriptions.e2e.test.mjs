import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

test('guided provisioning creates plan and assignments atomically', async () => {
  const gw = await startGateway()
  try {
    const user = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'wizard-user', password: 'test-password-123', role: 'user' },
    })
    const userId = user.json.data.item.id
    const plan = { name: 'Wizard plan', platform: 'claude', vm_ids: ['vm-sim-01'], daily_limit_usd: 30 }
    const invalid = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: { plan, user_ids: [userId, 'missing-user'] },
    })
    assert.equal(invalid.status, 400)
    assert.equal((await api(gw, 'GET', '/api/panel/subscription-plans')).json.data.items.length, 0)
    assert.equal((await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.length, 0)
    const created = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: { plan, user_ids: [userId], validity_days: 7 },
    })
    assert.equal(created.status, 200, created.text)
    assert.equal(created.json.data.ids.length, 1)
    const login = await api(gw, 'POST', '/api/panel/login', {
      body: { username: 'wizard-user', password: 'test-password-123' },
    })
    const headers = { authorization: `Bearer ${login.json.token}` }
    const own = await api(gw, 'GET', '/api/panel/subscriptions', { headers })
    assert.equal(own.json.data.items[0].availability.code, 'configured')
    assert.equal(own.json.data.items[0].vm_ids, undefined)
    assert.equal(own.json.data.items[0].assigned_by, undefined)
    assert.equal(
      (await api(gw, 'POST', '/api/panel/subscriptions/provision', { headers, body: { plan, user_ids: [userId] } }))
        .status,
      403,
    )
  } finally {
    await gw.stop()
  }
})

test('two subscribers share a slot, cannot see each other, and revocation invalidates old keys', async () => {
  const gw = await startGateway({ mockText: 'subscription-ok', readyMs: 15000 })
  try {
    const login = async (name) => {
      const r = await api(gw, 'POST', '/api/panel/login', { body: { username: name, password: 'test-password-123' } })
      assert.equal(r.status, 200, r.text)
      return { authorization: `Bearer ${r.json.token}` }
    }
    const ids = []
    for (const username of ['subscriber-a', 'subscriber-b', 'outsider']) {
      const r = await api(gw, 'POST', '/api/panel/users', {
        body: { username, password: 'test-password-123', role: 'user' },
      })
      assert.equal(r.status, 201, r.text)
      ids.push(r.json.data.item.id)
    }
    const plan = await api(gw, 'POST', '/api/panel/subscription-plans', {
      body: {
        name: 'Shared Claude',
        platform: 'claude',
        vm_ids: ['vm-sim-01'],
        daily_limit_usd: 30,
        weekly_limit_usd: 100,
      },
    })
    assert.equal(plan.status, 200, plan.text)
    const group_id = plan.json.data.id
    const assigned = await api(gw, 'POST', '/api/panel/subscriptions', {
      body: { group_id, user_ids: ids.slice(0, 2) },
    })
    assert.equal(assigned.status, 200, assigned.text)
    const users = await Promise.all(['subscriber-a', 'subscriber-b', 'outsider'].map(login))
    const keys = []
    for (let i = 0; i < 2; i++) {
      const r = await api(gw, 'POST', '/api/panel/api-keys', {
        headers: users[i],
        body: { name: 'own-key', group_id, user_id: ids[2] },
      })
      assert.equal(r.status, 201, r.text)
      assert.equal(r.json.item.user_id, ids[i])
      keys.push(r.json.item)
    }
    const noAccess = await api(gw, 'POST', '/api/panel/api-keys', {
      headers: users[2],
      body: { name: 'forged', group_id },
    })
    assert.equal(noAccess.status, 400, noAccess.text)
    const forbidden = await api(gw, 'POST', '/api/panel/subscriptions', {
      headers: users[0],
      body: { group_id, user_ids: [ids[2]] },
    })
    assert.equal(forbidden.status, 403)
    const call = (key) =>
      api(gw, 'POST', '/v1/messages', {
        headers: { authorization: `Bearer ${key.key}`, 'x-request-id': 'same-client-request-id', 'x-kin-log': 'off' },
        body: { model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
      })
    for (const key of keys) {
      const r = await call(key)
      assert.equal(r.status, 200, r.text)
    }
    for (let i = 0; i < 2; i++) {
      const r = await api(gw, 'GET', `/api/panel/usage-records?user_id=${ids[1 - i]}`, { headers: users[i] })
      assert.equal(r.status, 200, r.text)
      assert.equal(r.json.data.total, 1)
      assert.equal(r.json.data.items[0].api_key_id, keys[i].id)
      assert.equal(r.json.data.items[0].vm_id, undefined)
      const sub = await api(gw, 'GET', '/api/panel/subscriptions', { headers: users[i] })
      assert.equal(sub.json.data.items.length, 1)
      assert.ok(sub.json.data.items[0].daily_used > 0)
    }
    const all = await api(gw, 'GET', `/api/panel/usage-records?group_id=${group_id}`)
    assert.equal(all.json.data.total, 2, all.text)
    assert.notEqual(all.json.data.items[0].request_id, all.json.data.items[1].request_id)
    const snoop = await api(
      gw,
      'GET',
      `/api/panel/request-logs/${all.json.data.items.find((r) => r.user_id === ids[1]).request_id}`,
      { headers: users[0] },
    )
    assert.equal(snoop.status, 404)
    const revoked = await api(gw, 'PATCH', `/api/panel/subscriptions/${assigned.json.data.ids[0]}`, {
      body: { status: 'revoked' },
    })
    assert.equal(revoked.status, 200, revoked.text)
    assert.equal((await call(keys[0])).status, 403)
    const still = await call(keys[1])
    assert.equal(still.status, 200, still.text)
    assert.equal((await api(gw, 'GET', '/api/panel/vms/vm-sim-01', { headers: users[0] })).status, 404)
  } finally {
    await gw.stop()
  }
})
