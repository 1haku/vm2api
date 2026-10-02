import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SubscriptionsRepo } from '../../src/lib/db/repos/subscriptions-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { usageRecords } from '../../src/lib/admin/panel-subscriptions.mjs'
import { ownerScopeFromRequest, vmMatchesOwnerScope } from '../../src/lib/admin/resource-owner.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { resolveOutboundSessionId } from '../../src/lib/identity/identity-rewrite.mjs'

function setup(t, config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subscription-test-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  for (const id of ['a', 'b', 'c'])
    db.prepare('INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(
      id,
      `${id}@example.test`,
      id,
      'unused',
      'user',
      'active',
    )
  for (const id of ['vm-1', 'vm-2']) db.prepare('INSERT INTO vms(id,name,vm_json) VALUES(?,?,?)').run(id, id, '{}')
  const repo = new SubscriptionsRepo(db)
  const plan = repo.savePlan(
    { name: 'Shared', vm_ids: ['vm-1'], daily_limit_usd: 30, weekly_limit_usd: 100, ...config },
    'admin',
  )
  repo.assign({ group_id: plan.id, user_ids: ['a', 'b'] }, 'admin')
  const a = { id: 'key-a', user_id: 'a', group_id: plan.id }
  const b = { id: 'key-b', user_id: 'b', group_id: plan.id }
  return { dir, db, repo, plan, a, b }
}
const body = { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }

test('key aggregates cover the whole selected range, retain deleted key history, and never cross user ownership', (t) => {
  const { db, plan } = setup(t)
  db.prepare('INSERT INTO api_keys(id,key,user_id,name) VALUES(?,?,?,?)').run(
    'first-key',
    'never-used-test-key',
    'b',
    'Other user private name',
  )
  const logs = new UsageLogsRepo(db)
  for (const [id, user, key, day, status, cost] of [
    ['a1', 'a', 'first-key', '01', 200, 1],
    ['a2', 'a', 'first-key', '02', 200, 3],
    ['a3', 'a', 'deleted-key', '02', 503, 2],
    ['a-old', 'a', 'first-key', '15', 200, 20],
    ['b1', 'b', 'first-key', '02', 200, 900],
    ['b2', 'b', 'foreign-key', '02', 200, 500],
  ])
    logs.insertSummary({
      id,
      request_id: id,
      user_id: user,
      api_key_id: key,
      group_id: plan.id,
      created_at: `2026-09-${day}T12:00:00.000Z`,
      status,
      actual_cost: cost,
      total_cost: cost,
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_creation_tokens: 10,
    })
  const params = new URLSearchParams({
    from: '2026-09-01T00:00:00Z',
    until: '2026-09-03T00:00:00Z',
    page_size: '1',
    user_id: 'b',
  })
  const own = usageRecords(db, params, 'a', false)
  assert.equal(own.items.length, 1)
  assert.equal(own.keys.length, 2)
  assert.equal(
    own.keys.reduce((sum, k) => sum + k.requests, 0),
    own.total,
  )
  assert.equal(
    own.keys.reduce((sum, k) => sum + k.actual_cost, 0),
    6,
  )
  const first = own.keys.find((k) => k.api_key_id === 'first-key')
  assert.equal(first.requests, 2)
  assert.equal(first.input_tokens, 200)
  assert.equal(first.cache_read_tokens, 60)
  assert.equal(first.last_used_at, '2026-09-02T12:00:00.000Z')
  assert.equal(own.keys.find((k) => k.api_key_id === 'deleted-key').success, 0)
  assert.equal(first.user_id, undefined)
  assert.equal(first.key_name, null)
  params.set('api_key_id', 'foreign-key')
  assert.deepEqual(usageRecords(db, params, 'a', false).keys, [])
  params.set('api_key_id', 'first-key')
  assert.equal(usageRecords(db, params, 'a', false).totals.actual_cost, 4)
  assert.equal(usageRecords(db, params, 'a', false).items[0].key_name, null)
  params.delete('api_key_id')
  params.delete('user_id')
  assert.equal(usageRecords(db, params, null, true).totals.actual_cost, 1406)
  params.set('status', 'error')
  assert.equal(usageRecords(db, params, 'a', false).keys[0].api_key_id, 'deleted-key')
})

test('shared slot grants separate entitlements and rejects unassigned, paused, expired users', (t) => {
  const { db, repo, plan, a, b } = setup(t)
  assert.deepEqual(repo.entitlement(a).vmIds, ['vm-1'])
  assert.deepEqual(repo.entitlement(b).vmIds, ['vm-1'])
  assert.throws(() => repo.entitlement({ ...a, user_id: 'c' }), /订阅/)
  const scope = ownerScopeFromRequest({ apiKeyRecord: a }, { db })
  assert.equal(vmMatchesOwnerScope({ id: 'vm-1' }, scope), true)
  assert.equal(vmMatchesOwnerScope({ id: 'vm-2' }, scope), false)
  assert.throws(() => repo.savePlan({ name: 'Duplicate', vm_ids: ['vm-1'] }, 'admin'), /已绑定/)
  repo.update(repo.entitlement(a).id, { status: 'revoked' }, 'admin')
  assert.throws(() => repo.entitlement(a), /订阅/)
  assert.ok(repo.entitlement(b))
  db.prepare('UPDATE user_subscriptions SET expires_at=? WHERE user_id=?').run('2020-01-01T00:00:00.000Z', 'b')
  assert.throws(() => repo.entitlement(b), /到期/)
  assert.equal(repo.plans().find((p) => p.id === plan.id).members, 0)
})

test('multiple keys share quota and concurrency; settlement is idempotent; reset retains history', (t) => {
  const { repo, db, a, b } = setup(t, { subscription_concurrency: 1 })
  const admitted = repo.reserve(a, 'request-a', body)
  assert.throws(() => repo.reserve({ ...a, id: 'second-key' }, 'request-a2', body), /并发/)
  assert.ok(repo.reserve(b, 'request-b', body))
  repo.settle('request-a', admitted.id, 29.99)
  repo.settle('request-a', admitted.id, 29.99)
  assert.equal(repo.progress(admitted).daily_used, 29.99)
  assert.throws(() => repo.reserve({ ...a, id: 'second-key' }, 'request-a3', body), /额度/)
  repo.update(admitted.id, { action: 'reset' }, 'admin')
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM subscription_ledger WHERE subscription_id=?').get(admitted.id).n,
    1,
  )
  assert.ok(repo.reserve(a, 'request-a4', body))
})

test('usage stays attached to caller after VM/key transfer, including totals and export source', (t) => {
  const { db } = setup(t)
  const logs = new UsageLogsRepo(db)
  for (const [id, user, cost] of [
    ['ra', 'a', 1],
    ['rb', 'b', 9],
    ['legacy', null, 3],
  ])
    logs.insertSummary({
      id,
      request_id: id,
      user_id: user,
      vm_id: 'vm-1',
      created_at: new Date().toISOString(),
      status: 200,
      actual_cost: cost,
      total_cost: cost,
    })
  db.prepare('UPDATE vms SET owner_user_id=? WHERE id=?').run('a', 'vm-1')
  assert.equal(logs.ownerBilling({ ownerUserId: 'a' }).totals.requests, 1)
  assert.equal(logs.belongsToOwner('rb', 'a'), false)
  assert.equal(logs.belongsToOwner('legacy', 'a'), false)
  const own = usageRecords(db, new URLSearchParams({ user_id: 'b' }), 'a', false)
  assert.equal(own.total, 1)
  assert.equal(own.totals.actual_cost, 1)
  assert.equal(own.items[0].vm_id, undefined)
  assert.equal(own.items[0].username, undefined)
  assert.equal(usageRecords(db, new URLSearchParams(), null, true).total, 3)
})

test('log off still records subscription usage and settles reservation exactly once', (t) => {
  const { db, dir, repo, a } = setup(t)
  const log = new RequestLogStore({ db, dataDir: dir, mode: 'off' })
  const ctx = log.start({ headers: {}, method: 'POST', url: '/v1/messages' })
  const sub = repo.reserve(a, ctx.request_id, body)
  const extra = {
    user_id: 'a',
    subscription_id: sub.id,
    group_id: a.group_id,
    status: 200,
    model: body.model,
    usage: { input_tokens: 1000, output_tokens: 100 },
    rate_multiplier: 1,
  }
  log.finish(ctx, extra)
  log.finish(ctx, extra)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscription_ledger').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscription_reservations').get().n, 0)
  assert.ok(repo.progress(sub).daily_used > 0)
})

test('shared client session identifiers remain isolated by user', (t) => {
  const { db, a, b } = setup(t)
  const router = new StickyRouter({ db })
  const ra = { apiKeyRecord: a },
    rb = { apiKeyRecord: b }
  assert.notEqual(router.canonicalSessionKey('same', ra), router.canonicalSessionKey('same', rb))
  assert.notEqual(router.canonicalDeviceKey('same', ra), router.canonicalDeviceKey('same', rb))
  assert.notEqual(
    resolveOutboundSessionId('same', { tenantId: 'a' }),
    resolveOutboundSessionId('same', { tenantId: 'b' }),
  )
})

test('stored Codex responses belong to one user and one subscription', (t) => {
  const { repo, a, b } = setup(t)
  repo.rememberResponse('resp_a', a, 'vm-1')
  assert.equal(repo.responseOwner('resp_a', a).vm_id, 'vm-1')
  assert.equal(repo.responseOwner('resp_a', b), undefined)
  assert.equal(repo.responseOwner('resp_a', { ...a, group_id: 1 }), undefined)
  repo.rememberResponse('resp_a', b, 'vm-2')
  assert.equal(repo.responseOwner('resp_a', b), undefined)
})

test('restart releases unknown reservations without inventing actual costs', (t) => {
  const { repo, db, a } = setup(t)
  const sub = repo.reserve(a, 'interrupted', body)
  assert.equal(repo.recoverReservations(), 1)
  assert.equal(repo.recoverReservations(), 0)
  assert.equal(repo.progress(sub).daily_used, 0)
  assert.equal(
    db.prepare('SELECT action FROM subscription_events ORDER BY id DESC LIMIT 1').get().action,
    'interrupted_reservation_released',
  )
})
