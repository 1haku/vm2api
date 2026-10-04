import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { startGateway, api } from '../harness.mjs'

test('new logs and statistics remain caller-scoped after key and slot ownership transfers', async () => {
  const gw = await startGateway()
  let db
  try {
    const ids = [],
      sessions = [],
      keys = []
    for (const username of ['stats-alice', 'stats-bob']) {
      const user = await api(gw, 'POST', '/api/panel/users', {
        body: { username, password: 'test-password-123', role: 'user' },
      })
      assert.equal(user.status, 201, user.text)
      ids.push(user.json.data.item.id)
      const login = await api(gw, 'POST', '/api/panel/login', { body: { username, password: 'test-password-123' } })
      assert.equal(login.status, 200, login.text)
      sessions.push({ authorization: `Bearer ${login.json.token}` })
    }
    const plan = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: {
        plan: { name: 'Statistics shared slot', platform: 'claude', vm_ids: ['vm-sim-01'], daily_limit_usd: 30 },
        user_ids: ids,
      },
    })
    assert.equal(plan.status, 200, plan.text)
    const sub = (await api(gw, 'GET', '/api/panel/subscriptions')).json.data.items.find((s) => s.user_id === ids[0])
    for (let i = 0; i < 2; i++) {
      const key = await api(gw, 'POST', '/api/panel/api-keys', {
        headers: sessions[i],
        body: { name: `stats-key-${i}`, group_id: sub.group_id },
      })
      assert.equal(key.status, 201, key.text)
      keys.push(key.json.item)
      const call = await api(gw, 'POST', '/v1/messages', {
        headers: {
          authorization: `Bearer ${key.json.item.key}`,
          'x-session-id': `tenant-session-${i}`,
          'x-kin-log': 'off',
        },
        body: { model: 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
      })
      assert.equal(call.status, 200, call.text)
    }
    db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    db.exec('PRAGMA busy_timeout=5000')
    db.prepare('UPDATE api_keys SET user_id=? WHERE id=?').run(ids[1], keys[0].id)
    db.prepare("UPDATE vms SET owner_user_id=? WHERE id='vm-sim-01'").run(ids[1])
    for (let i = 0; i < 2; i++) {
      const query = `user_id=${ids[1 - i]}`
      const logs = await api(gw, 'GET', `/api/panel/usage-logs?${query}`, { headers: sessions[i] })
      assert.equal(logs.status, 200, logs.text)
      assert.equal(logs.json.data.logs.length, 1)
      assert.equal(logs.json.data.logs[0].userId, ids[i])
      assert.equal(logs.json.data.logs[0].keyId, keys[i].id)
      const summary = await api(gw, 'GET', `/api/panel/usage-logs/summary?${query}`, { headers: sessions[i] })
      assert.equal(summary.status, 200, summary.text)
      assert.equal(summary.json.data.totalRequests, 1)
      const foreignKey = await api(gw, 'GET', `/api/panel/usage-logs?key_id=${keys[1 - i].id}`, {
        headers: sessions[i],
      })
      assert.equal(foreignKey.json.data.logs.length, 0)
      for (const route of ['filter-options', 'session-suggestions', 'active-sessions', 'overview']) {
        const result = await api(gw, 'GET', `/api/panel/usage-logs/${route}?${query}`, { headers: sessions[i] })
        assert.equal(result.status, 200, result.text)
        assert.ok(!JSON.stringify(result.json).includes(`tenant-session-${1 - i}`), route + ' foreign session')
        assert.ok(
          !JSON.stringify(result.json).includes(`stats-${i === 0 ? 'bob' : 'alice'}`),
          route + ' foreign username',
        )
      }
      for (const route of ['/api/panel/statistics?dimension=model', '/api/panel/statistics/leaderboard?scope=key']) {
        const stats = await api(gw, 'GET', `${route}&${query}&tz=UTC`, { headers: sessions[i] })
        assert.equal(stats.status, 200, stats.text)
        assert.ok(!JSON.stringify(stats.json).includes(keys[1 - i].id), 'foreign key must not enter aggregates')
      }
      assert.equal((await api(gw, 'GET', '/api/panel/statistics?dimension=vm', { headers: sessions[i] })).status, 400)
      assert.equal(
        (await api(gw, 'GET', '/api/panel/statistics/leaderboard?scope=user', { headers: sessions[i] })).status,
        400,
      )
    }
    const all = await api(gw, 'GET', '/api/panel/usage-logs')
    assert.equal(all.json.data.logs.filter((row) => ids.includes(row.userId)).length, 2)
    const unauthenticated = await fetch(gw.baseUrl + '/api/panel/statistics')
    assert.equal(unauthenticated.status, 401)
  } finally {
    db?.close()
    await gw.stop()
  }
})
