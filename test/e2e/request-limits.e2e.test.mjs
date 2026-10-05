import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api } from '../harness.mjs'

const message = { model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }
async function setup(gw) {
  const users = [],
    sessions = []
  for (const username of ['limit-alice', 'limit-bob']) {
    const u = await api(gw, 'POST', '/api/panel/users', {
      body: { username, password: 'test-password-123', role: 'user', concurrency: 3, rpm_limit: 0 },
    })
    assert.equal(u.status, 201, u.text)
    users.push(u.json.data.item)
    const s = await api(gw, 'POST', '/api/panel/login', { body: { username, password: 'test-password-123' } })
    assert.equal(s.status, 200, s.text)
    sessions.push({ authorization: `Bearer ${s.json.token}` })
  }
  const plan = await api(gw, 'POST', '/api/panel/subscription-plans', {
    body: {
      name: 'Limited plan',
      platform: 'claude',
      vm_ids: ['vm-sim-01'],
      daily_limit_usd: 30,
      subscription_concurrency: 3,
      group_rpm_limit: 0,
      user_rpm_limit: 0,
    },
  })
  assert.equal(plan.status, 200, plan.text)
  const group_id = plan.json.data.id
  assert.equal(
    (await api(gw, 'POST', '/api/panel/subscriptions', { body: { group_id, user_ids: users.map((u) => u.id) } }))
      .status,
    200,
  )
  const keys = []
  for (const i of [0, 0, 1]) {
    const k = await api(gw, 'POST', '/api/panel/api-keys', {
      headers: sessions[i],
      body: { name: 'limit-test-key', group_id, max_concurrency: 0, rpm: 0 },
    })
    assert.equal(k.status, 201, k.text)
    keys.push(k.json.item)
  }
  return { users, sessions, keys, group_id }
}

test('managed HTTP requests share user and group RPM; forbidden edits and rejections do not consume other quotas', async () => {
  const gw = await startGateway()
  const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
  db.exec('PRAGMA busy_timeout=5000')
  try {
    const { users, sessions, keys, group_id } = await setup(gw)
    const call = (key, body = message, route = '/v1/messages') =>
      api(gw, 'POST', route, { headers: { authorization: `Bearer ${key.key}` }, body })
    const patchUser = (body) => api(gw, 'PATCH', `/api/panel/users/${users[0].id}`, { body })
    const patchPlan = (body) => api(gw, 'PATCH', `/api/panel/subscription-plans/${group_id}`, { body })
    const clear = () => db.prepare('UPDATE custom_request_rpm_events SET started_at=0').run()
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM custom_request_rpm_events WHERE started_at>0').get().n
    assert.equal((await patchUser({ rpm_limit: 1 })).status, 200)
    assert.equal(
      (
        await api(gw, 'PATCH', `/api/panel/users/${users[0].id}`, {
          headers: sessions[0],
          body: { rpm_limit: 0, concurrency: 0 },
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await api(gw, 'PATCH', `/api/panel/subscription-plans/${group_id}`, {
          headers: sessions[0],
          body: { group_rpm_limit: 0 },
        })
      ).status,
      403,
    )
    for (const bad of [-1, 0.1, null, '10', 1000001]) assert.equal((await patchUser({ rpm_limit: bad })).status, 400)
    assert.equal((await call(keys[0])).status, 200)
    const blocked = await call(keys[1])
    assert.equal(blocked.status, 429, blocked.text)
    assert.equal(blocked.json.error.code, 'user_rpm_limit')
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)
    assert.equal(count(), 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_subscription_reservations').get().n, 0)
    const revoked = await api(gw, 'DELETE', `/api/panel/api-keys/${keys[0].id}`, { headers: sessions[0] })
    assert.equal(revoked.status, 200)
    assert.equal((await call(keys[1])).status, 429)
    assert.equal((await call(keys[2])).status, 200)
    clear()
    assert.equal((await patchUser({ rpm_limit: 0 })).status, 200)
    assert.equal((await patchPlan({ group_rpm_limit: 1 })).status, 200)
    assert.equal((await call(keys[1])).status, 200)
    const groupBlock = await call(keys[2])
    assert.equal(groupBlock.json.error.code, 'group_rpm_limit', groupBlock.text)
    assert.equal(count(), 1)
    clear()
    assert.equal((await patchPlan({ group_rpm_limit: 0, user_rpm_limit: 1 })).status, 200)
    assert.equal((await call(keys[1])).status, 200)
    assert.equal((await call(keys[1])).json.error.code, 'subscription_user_rpm_limit')
    assert.equal((await call(keys[2])).status, 200)
    clear()
    assert.equal((await patchPlan({ user_rpm_limit: 0 })).status, 200)
    // Codex is rejected for this Claude-only plan, but must still pass the common key/user admission.
    assert.equal((await patchUser({ rpm_limit: 1 })).status, 200)
    const codex = await call(keys[1], { model: 'gpt-5.4', input: 'hi', stream: false }, '/v1/responses')
    assert.notEqual(codex.status, 200)
    assert.notEqual(codex.status, 429, codex.text)
    assert.equal(count(), 1, 'Codex enters the same limiter once')
    assert.equal((await call(keys[1])).json.error.code, 'user_rpm_limit')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_subscription_reservations').get().n, 0)
  } finally {
    db.close()
    await gw.stop()
  }
})

test('user RPM persists through a gateway restart and successful requests release user concurrency', async () => {
  let gw = await startGateway()
  try {
    const { users, keys } = await setup(gw)
    assert.equal(
      (await api(gw, 'PATCH', `/api/panel/users/${users[0].id}`, { body: { concurrency: 1, rpm_limit: 2 } })).status,
      200,
    )
    const call = () =>
      api(gw, 'POST', '/v1/messages', { headers: { authorization: `Bearer ${keys[1].key}` }, body: message })
    assert.equal((await call()).status, 200)
    const project = gw.project
    await gw.stop()
    gw = await startGateway({ project })
    assert.equal((await call()).status, 200, 'restart preserves first request count but clears completed claims')
    const blocked = await call()
    assert.equal(blocked.status, 429, blocked.text)
    assert.equal(blocked.json.error.code, 'user_rpm_limit')
  } finally {
    await gw.stop()
  }
})
