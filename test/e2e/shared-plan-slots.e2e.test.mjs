import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

test('multiple plans use one slot with separate keys, usage, access and binding lifecycle', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'shared-plan-user', password: 'test-password-123', role: 'user' },
    })
    assert.equal(created.status, 201, created.text)
    const userId = created.json.data.item.id
    const login = await api(gw, 'POST', '/api/panel/login', {
      body: { username: 'shared-plan-user', password: 'test-password-123' },
    })
    const headers = { authorization: `Bearer ${login.json.token}` }
    const plans = [],
      keys = [],
      subscriptions = []
    for (const [name, daily_limit_usd] of [
      ['Basic', 30],
      ['Premium', 80],
    ]) {
      const provision = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
        body: { plan: { name, vm_ids: ['vm-sim-01'], platform: 'claude', daily_limit_usd }, user_ids: [userId] },
      })
      assert.equal(provision.status, 200, provision.text)
      plans.push(provision.json.data.plan.id)
      subscriptions.push(provision.json.data.ids[0])
      const key = await api(gw, 'POST', '/api/panel/api-keys', { headers, body: { name, group_id: plans.at(-1) } })
      assert.equal(key.status, 201, key.text)
      keys.push(key.json.item.key)
    }
    const call = (key) =>
      api(gw, 'POST', '/v1/messages', {
        headers: { authorization: `Bearer ${key}` },
        body: { model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
      })
    assert.equal((await call(keys[0])).status, 200)
    let own = (await api(gw, 'GET', '/api/panel/subscriptions', { headers })).json.data.items
    assert.ok(own.find((s) => s.id === subscriptions[0]).daily_used > 0)
    assert.equal(own.find((s) => s.id === subscriptions[1]).daily_used, 0)
    assert.equal((await call(keys[1])).status, 200)
    const revoke = await api(gw, 'PATCH', `/api/panel/subscriptions/${subscriptions[0]}`, {
      body: { status: 'revoked' },
    })
    assert.equal(revoke.status, 200)
    assert.equal((await call(keys[0])).status, 403)
    assert.equal((await call(keys[1])).status, 200)
    const unbind = await api(gw, 'PATCH', `/api/panel/subscription-plans/${plans[0]}`, {
      body: { status: 'disabled', vm_ids: [] },
    })
    assert.equal(unbind.status, 200, unbind.text)
    const all = (await api(gw, 'GET', '/api/panel/subscription-plans')).json.data.items
    assert.deepEqual(all.find((p) => p.id === plans[1]).vm_ids, ['vm-sim-01'])
    const blockedDelete = await api(gw, 'DELETE', '/api/panel/vms/vm-sim-01')
    assert.equal(blockedDelete.status, 409)
    assert.match(blockedDelete.text, /订阅/)
    const mismatch = await api(gw, 'POST', '/api/panel/subscription-plans', {
      body: { name: 'Wrong platform', platform: 'openai', vm_ids: ['vm-sim-01'] },
    })
    assert.equal(mismatch.status, 400)
    const forbidden = await api(gw, 'POST', '/api/panel/subscription-plans', {
      headers,
      body: { name: 'Forbidden', vm_ids: ['vm-sim-01'] },
    })
    assert.equal(forbidden.status, 403)
  } finally {
    await gw.stop()
  }
})
