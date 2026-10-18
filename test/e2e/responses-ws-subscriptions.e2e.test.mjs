import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { startGateway, api } from '../harness.mjs'

function turn(ws, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('WebSocket turn timed out')), 8000)
    const finish = (error, result) => {
      clearTimeout(timer)
      ws.off('message', receive)
      ws.off('error', fail)
      error ? reject(error) : resolve(result)
    }
    const fail = (error) => finish(error)
    const receive = (data) => {
      const event = JSON.parse(String(data))
      if (['response.completed', 'response.failed', 'response.incomplete', 'error'].includes(event.type))
        finish(null, event)
    }
    ws.on('message', receive)
    ws.once('error', fail)
    ws.send(JSON.stringify({ type: 'response.create', ...body }))
  })
}

test('WebSocket rejected turns release reservations and recheck quota, revocation and key auth on an open connection', async () => {
  const gw = await startGateway()
  let ws
  try {
    const created = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'ws-subscriber', password: 'fixture-password-123', role: 'user' },
    })
    const userId = created.json.data.item.id
    const provision = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: {
        plan: { name: 'WS plan', platform: 'claude', vm_ids: ['vm-sim-01'], daily_limit_usd: 30 },
        user_ids: [userId],
      },
    })
    assert.equal(provision.status, 200, provision.text)
    const getSub = async () =>
      (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.user_id === userId)
    const sub = await getSub()
    const createdKey = await api(gw, 'POST', '/api/panel/api-keys', {
      body: { name: 'ws-key', user_id: userId, group_id: sub.group_id },
    })
    assert.equal(createdKey.status, 201, createdKey.text)
    const key = createdKey.json.item
    ws = new WebSocket(gw.baseUrl.replace('http:', 'ws:') + '/v1/responses', {
      headers: { authorization: `Bearer ${key.key}` },
    })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const body = { model: 'claude-haiku-4-5', input: 'Reply OK.', max_output_tokens: 16 }
    const first = await turn(ws, body)
    // Deliberately incompatible model: exercise admission and cleanup without contacting an upstream.
    assert.equal(first.error?.code, 'protocol_not_allowed', JSON.stringify(first))
    let after
    for (let i = 0; i < 30; i++) {
      after = await getSub()
      if (after.pending_cost === 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(after.daily_used, 0)
    assert.equal(after.pending_cost, 0)
    const records = (await api(gw, 'GET', `/api/panel/usage-records?user_id=${userId}`)).json.data
    assert.equal(records.items[0].user_id, userId)
    assert.equal(records.items[0].api_key_id, key.id)
    const quota = await turn(ws, { ...body, max_output_tokens: 1000000000 })
    assert.equal(quota.error?.code, 'subscription_quota', JSON.stringify(quota))
    assert.equal((await getSub()).daily_used, after.daily_used)
    assert.equal((await getSub()).pending_cost, 0)
    const revoked = await api(gw, 'PATCH', `/api/panel/subscriptions/${sub.id}`, { body: { status: 'revoked' } })
    assert.equal(revoked.status, 200, revoked.text)
    const denied = await turn(ws, body)
    assert.equal(denied.status, 403, JSON.stringify(denied))
    assert.equal(denied.error?.code, 'subscription_inactive')
    const disabled = await api(gw, 'PATCH', `/api/panel/api-keys/${key.id}`, { body: { status: 'disabled' } })
    assert.equal(disabled.status, 200, disabled.text)
    const keyDenied = await turn(ws, body)
    assert.ok([401, 403].includes(keyDenied.status), JSON.stringify(keyDenied))
    assert.notEqual(keyDenied.error?.code, 'subscription_inactive', 'key must be reauthenticated each turn')
  } finally {
    ws?.terminate()
    await gw.stop()
  }
})
