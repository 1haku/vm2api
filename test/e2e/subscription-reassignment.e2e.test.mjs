import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway, api } from '../harness.mjs'

test('revoked subscription reopens for the selected shorter duration through the panel API', async () => {
  const gw = await startGateway()
  try {
    const user = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'reassigned-user', password: 'test-password-123', role: 'user' },
    })
    assert.equal(user.status, 201, user.text)
    const provision = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: {
        plan: { name: 'Reassignment plan', vm_ids: ['vm-sim-01'], platform: 'claude', default_validity_days: 60 },
        user_ids: [user.json.data.item.id],
      },
    })
    assert.equal(provision.status, 200, provision.text)
    const id = provision.json.data.ids[0],
      group_id = provision.json.data.plan.id
    const list = async () => (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.id === id)
    const initial = await list()
    for (const days of [3, 1]) {
      assert.equal(
        (await api(gw, 'PATCH', `/api/panel/subscriptions/${id}`, { body: { status: 'revoked' } })).status,
        200,
      )
      assert.equal(
        (await api(gw, 'PATCH', `/api/panel/subscriptions/${id}`, { body: { action: 'renew', days } })).status,
        400,
      )
      const from = Date.now()
      const assigned = await api(gw, 'POST', '/api/panel/subscriptions', {
        body: { group_id, user_ids: [user.json.data.item.id], validity_days: days },
      })
      const until = Date.now()
      assert.equal(assigned.status, 200, assigned.text)
      assert.deepEqual(assigned.json.data.ids, [id])
      const current = await list(),
        expires = Date.parse(current.expires_at)
      assert.equal(current.status, 'active')
      assert.ok(expires >= from + days * 86400000 && expires <= until + days * 86400000)
      assert.ok(current.expires_at < initial.expires_at)
    }
    const beforeRenew = await list()
    assert.equal(
      (
        await api(gw, 'POST', '/api/panel/subscriptions', {
          body: { group_id, user_ids: [user.json.data.item.id], validity_days: 2 },
        })
      ).status,
      200,
    )
    assert.equal(Date.parse((await list()).expires_at), Date.parse(beforeRenew.expires_at) + 2 * 86400000)
    const events = await api(gw, 'GET', '/api/panel/subscriptions/events')
    assert.equal(events.json.data.items.filter((e) => e.subscription_id === id && e.action === 'reassigned').length, 2)
  } finally {
    await gw.stop()
  }
})
