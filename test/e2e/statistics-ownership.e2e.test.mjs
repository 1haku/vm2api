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
    const transferredStats = await api(gw, 'GET', `/api/panel/api-keys/${keys[0].id}/stats`, { headers: sessions[1] })
    assert.equal(transferredStats.status, 200, transferredStats.text)
    assert.equal(transferredStats.json.usage_stats.history.length, 0)
    const oldOwnerStats = await api(gw, 'GET', `/api/panel/api-keys/${keys[0].id}/stats`, { headers: sessions[0] })
    assert.equal(oldOwnerStats.status, 404)
    const adminStats = await api(gw, 'GET', `/api/panel/api-keys/${keys[0].id}/stats`)
    assert.equal(adminStats.status, 200, adminStats.text)
    assert.equal(adminStats.json.usage_stats.history[0].requests, 1)
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
    // Tenant stats must exclude global errors/IPs and global sticky attempts,
    // even if a caller supplies another user's filter after a key transfer.
    const before = await api(gw, 'GET', '/api/panel/request-logs/stats', { headers: sessions[0] })
    const stickyBefore = before.json.window.sticky
    const now = new Date().toISOString()
    for (const [id, owner, ip] of [
      ['scope-a', ids[0], '192.0.2.1'],
      ['scope-b', ids[1], '198.51.100.2'],
      ['scope-anon', null, '203.0.113.3'],
    ]) {
      db.prepare(
        'INSERT INTO usage_logs(id,request_id,user_id,created_at,status,error_code,error_message,ip_address) VALUES(?,?,?,?,?,?,?,?)',
      ).run(id, id, owner, now, 401, 'invalid_api_key', id, ip)
      db.prepare('INSERT INTO request_attempts(request_id,attempt_no,selection_reason,started_at) VALUES(?,?,?,?)').run(
        id,
        1,
        'sticky',
        now,
      )
    }
    const ownStats = await api(gw, 'GET', `/api/panel/request-logs/stats?user_id=${ids[1]}`, { headers: sessions[0] })
    assert.equal(ownStats.status, 200, ownStats.text)
    assert.equal(ownStats.json.totals, null)
    assert.equal(ownStats.json.config, null)
    assert.equal(ownStats.json.window.sticky.selections, stickyBefore.selections + 1)
    assert.equal(ownStats.json.window.sticky.hits, stickyBefore.hits + 1)
    assert.deepEqual(
      ownStats.json.window.error_collection.ingress_hits.map((row) => row.ip),
      ['192.0.2.1'],
    )
    assert.doesNotMatch(JSON.stringify(ownStats.json), /scope-b|scope-anon|198\.51\.100\.2|203\.0\.113\.3/)
    const adminStatsAll = await api(gw, 'GET', '/api/panel/request-logs/stats')
    assert.ok(adminStatsAll.json.totals)
    assert.ok(adminStatsAll.json.config)
    assert.equal(adminStatsAll.json.window.error_collection.ingress_hits.length, 3)
  } finally {
    db?.close()
    await gw.stop()
  }
})
