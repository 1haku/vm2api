import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startGateway, api } from '../harness.mjs'
import { classifierFixture } from '../fixtures/auto-mode.mjs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

test('named pools preserve subscription admission and release reservations when disabled or empty', async () => {
  const gw = await startGateway()
  try {
    const user = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'pool-subscriber', password: 'test-password-123', role: 'user' },
    })
    const userId = user.json.data.item.id
    const provision = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: {
        plan: { name: 'Pool subscription', platform: 'claude', vm_ids: ['vm-sim-01'], daily_limit_usd: 30 },
        user_ids: [userId],
      },
    })
    assert.equal(provision.status, 200, provision.text)
    const sub = (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.user_id === userId)
    const pool = await api(gw, 'POST', '/api/panel/vm-pools', { body: { name: 'Shared pool', vm_ids: ['vm-sim-01'] } })
    assert.equal(pool.status, 201, pool.text)
    const poolId = pool.json.data.pool.id
    const key = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'pool-key', user_id: userId, group_id: sub.group_id, vm_pool_id: poolId },
    })
    assert.equal(key.status, 201, key.text)
    const headers = { authorization: `Bearer ${key.json.item.key}` }
    const body = { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }
    assert.equal((await api(gw, 'POST', '/v1/messages', { headers, body })).status, 200)
    const login = await api(gw, 'POST', '/api/panel/login', {
      body: { username: 'pool-subscriber', password: 'test-password-123' },
    })
    assert.equal(
      (await api(gw, 'GET', '/api/panel/vm-pools', { headers: { authorization: `Bearer ${login.json.token}` } }))
        .status,
      403,
    )
    for (const patch of [{ enabled: false }, { enabled: true, vm_ids: [] }]) {
      assert.equal((await api(gw, 'PATCH', `/api/panel/vm-pools/${poolId}`, { body: patch })).status, 200)
      const rejected = await api(gw, 'POST', '/v1/messages', { headers, body })
      assert.equal(rejected.status, 403, rejected.text)
      assert.equal(rejected.json.error.code, 'vm_pool_unavailable')
      const current = (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.id === sub.id)
      assert.equal(current.pending_cost, 0)
    }
    assert.equal((await api(gw, 'DELETE', `/api/panel/vm-pools/${poolId}`)).status, 409)
  } finally {
    await gw.stop()
  }
})

test('subscription admission ignores transport metadata and returns a useful logged quota rejection', async () => {
  const gw = await startGateway()
  try {
    const created = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'estimate-subscriber', password: 'test-password-123', role: 'user' },
    })
    const userId = created.json.data.item.id
    const provisioned = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: {
        plan: { name: 'Estimate plan', platform: 'claude', vm_ids: ['vm-sim-01'], daily_limit_usd: 0.05 },
        user_ids: [userId],
      },
    })
    assert.equal(provisioned.status, 200, provisioned.text)
    const sub = (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.user_id === userId)
    const key = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'estimate', user_id: userId, group_id: sub.group_id },
    })
    assert.equal(key.status, 201, key.text)
    const headers = { authorization: `Bearer ${key.json.item.key}` }
    const input = {
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'hi' }],
      metadata: { client_diagnostics: 'x'.repeat(300_000) },
      max_tokens: 8,
    }
    const accepted = await api(gw, 'POST', '/v1/messages', { headers, body: input })
    assert.equal(accepted.status, 200, accepted.text)
    const rejected = await api(gw, 'POST', '/v1/messages', { headers, body: { ...input, max_tokens: 1_000_000 } })
    assert.equal(rejected.status, 429, rejected.text)
    assert.equal(rejected.json.error.code, 'subscription_quota')
    assert.equal(rejected.json.error.quota.period, 'daily')
    assert.ok(rejected.json.error.quota.estimated > rejected.json.error.quota.remaining)
    const db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'), { readOnly: true })
    try {
      const logged = db
        .prepare(
          "SELECT error_message,actual_cost FROM usage_logs WHERE api_key_id=? AND error_code='subscription_quota'",
        )
        .get(key.json.item.id)
      assert.ok(logged)
      assert.equal(logged.error_message, rejected.json.error.message)
      assert.equal(logged.actual_cost, 0)
    } finally {
      db.close()
    }
  } finally {
    await gw.stop()
  }
})

test('classifier rejection releases subscription reservations without charging or bypassing revocation', async () => {
  const gw = await startGateway()
  try {
    const user = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'classifier-subscriber', password: 'test-password-123', role: 'user' },
    })
    assert.equal(user.status, 201, user.text)
    const assigned = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: {
        plan: {
          name: 'Classifier plan',
          platform: 'claude',
          vm_ids: ['vm-sim-01'],
          daily_limit_usd: 30,
          subscription_concurrency: 1,
        },
        user_ids: [user.json.data.item.id],
      },
    })
    assert.equal(assigned.status, 200, assigned.text)
    const subId = assigned.json.data.ids[0]
    const sub = (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.id === subId)
    const key = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'classifier', group_id: sub.group_id, user_id: user.json.data.item.id },
    })
    assert.equal(key.status, 201, key.text)
    const call = (body) =>
      api(gw, 'POST', '/v1/messages', {
        headers: {
          authorization: `Bearer ${key.json.item.key}`,
          'user-agent': 'claude-cli/2.1.284 (external, sdk-cli)',
          'x-kin-log': 'off',
        },
        body: {
          ...body,
          metadata: { user_id: { device_id: 'fixture-device', session_id: 'fixture-session' } },
          system: [
            { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.284; cc_entrypoint=sdk-cli; cch=00000;' },
            ...body.system,
          ],
        },
      })
    const rejected = await call({ ...classifierFixture(), thinking: { type: 'invalid' } })
    assert.equal(rejected.status, 400, rejected.text)
    assert.equal(rejected.json.error.code, 'classifier_model_incompatible')
    const afterReject = (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.id === subId)
    assert.equal(afterReject.pending_cost, 0)
    assert.equal(afterReject.daily_used, 0)
    // The mock runtime has no classifier capability: rejection must also release its reserved seat.
    for (const verdict of ['block', 'severity']) {
      const unsupported = await call(classifierFixture({ verdict }))
      assert.equal(unsupported.status, 400, unsupported.text)
      assert.equal(unsupported.json.error.code, 'classifier_runtime_unsupported')
      const afterUnsupported = (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find(
        (s) => s.id === subId,
      )
      assert.equal(afterUnsupported.pending_cost, 0)
      assert.equal(afterUnsupported.daily_used, 0)
    }
    const accepted = await call({
      model: 'claude-sonnet-4-6',
      max_tokens: 64,
      system: [],
      messages: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(accepted.status, 200, accepted.text)
    const after = (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.id === subId)
    assert.ok(after.daily_used > 0)
    assert.equal(after.pending_cost, 0)
    const logs = await api(gw, 'GET', `/api/panel/usage-records?group_id=${sub.group_id}`)
    assert.equal(logs.json.data.total, 4, logs.text)
    assert.ok(
      logs.json.data.items.every((r) => r.user_id === user.json.data.item.id && r.api_key_id === key.json.item.id),
    )
    assert.equal(
      (await api(gw, 'PATCH', `/api/panel/subscriptions/${subId}`, { body: { status: 'revoked' } })).status,
      200,
    )
    assert.equal((await call(classifierFixture())).status, 403)
    assert.equal((await call(classifierFixture({ verdict: 'severity' }))).status, 403)
  } finally {
    await gw.stop()
  }
})

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
    const adminTicket = await api(gw, 'POST', '/api/panel/vms/vm-sim-01/shell-ticket', { body: {} })
    assert.equal(adminTicket.status, 200, adminTicket.text)
    const unauthorizedUpgrade = await new Promise((resolve, reject) => {
      const ws = new WebSocket(gw.baseUrl.replace(/^http/, 'ws') + '/api/panel/vms/vm-sim-01/shell?ticket=invalid', {
        headers,
        handshakeTimeout: 3000,
      })
      ws.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode)
        ws.terminate()
      })
      ws.on('error', () => {})
      ws.on('open', () => {
        ws.close()
        reject(new Error('Invalid shell ticket accepted'))
      })
      setTimeout(() => {
        ws.terminate()
        reject(new Error('Shell denial timeout'))
      }, 3500).unref()
    })
    assert.equal(unauthorizedUpgrade, 401)
    assert.equal((await api(gw, 'GET', '/api/panel/subscriptions/admin-overview', { headers })).status, 403)
    assert.equal(
      (
        await api(gw, 'POST', '/api/panel/subscriptions/batch', {
          headers,
          body: { ids: created.json.data.ids, action: 'suspend' },
        })
      ).status,
      403,
    )
    assert.equal((await api(gw, 'POST', '/api/panel/vms/vm-sim-01/shell-ticket', { headers, body: {} })).status, 403)
    const overview = await api(gw, 'GET', '/api/panel/subscriptions/admin-overview')
    assert.equal(overview.status, 200, overview.text)
    assert.equal(overview.json.data.slots.find((s) => s.vm_id === 'vm-sim-01').subscribed_users, 1)
    assert.equal(
      (
        await api(gw, 'POST', '/api/panel/subscriptions/batch', {
          body: { ids: created.json.data.ids, action: 'renew', days: 7 },
        })
      ).status,
      200,
    )
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
      assert.equal(r.json.data.keys.length, 1)
      assert.equal(r.json.data.keys[0].api_key_id, keys[i].id)
      assert.equal(r.json.data.keys[0].requests, 1)
      assert.equal(r.json.data.keys[0].actual_cost, r.json.data.totals.actual_cost)
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
