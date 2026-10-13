import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { SubscriptionsRepo } from '../../src/lib/db/repos/subscriptions-repo.mjs'
import { readClaudeWeeklyReset, WEEK_MS } from '../../src/lib/admin/subscription-weekly-window.mjs'

const initial = Date.parse('2026-10-13T08:00:00Z')
const boundary = Date.parse('2026-10-14T10:00:00Z')
function setup(t) {
  let clock = initial
  t.mock.method(Date, 'now', () => clock)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-week-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  for (const id of ['a', 'b'])
    db.prepare('INSERT INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,?,?,?)').run(
      id,
      id + '@example.test',
      id,
      'unused',
      'user',
      'active',
    )
  for (const id of ['Claude', 'Other'])
    db.prepare('INSERT INTO vms(id,name,vm_json) VALUES(?,?,?)').run(
      id,
      id,
      JSON.stringify({ id, claude: { account_uuid: 'account-' + id } }),
    )
  const accounts = new AccountsRepo(db)
  accounts.insert({
    account_id: 'account-Claude',
    vm_id: 'Claude',
    unified: {
      headers: { '7d': { reset: String(boundary / 1000), utilization: 0.7 } },
      updated_at: new Date(initial).toISOString(),
    },
  })
  const repo = new SubscriptionsRepo(db)
  const plan = repo.savePlan(
    {
      name: 'Follow',
      vm_ids: ['Claude', 'Other'],
      daily_limit_usd: 100,
      weekly_limit_usd: 100,
      weekly_reset_mode: 'slot',
      weekly_reset_vm_id: 'Claude',
    },
    'admin',
  )
  const [a, b] = repo.assign({ group_id: plan.id, user_ids: ['a', 'b'] }, 'admin')
  const raw = (id) => db.prepare('SELECT * FROM custom_user_subscriptions WHERE id=?').get(id)
  const setReset = (value) => {
    const acc = accounts.get('account-Claude')
    acc.unified = { headers: { '7d': { reset: value, utilization: 0.1 } } }
    accounts.save(acc)
  }
  return {
    db,
    repo,
    plan,
    a,
    b,
    raw,
    setReset,
    time: (value) => {
      clock = value
    },
  }
}

test('selected official 7d total boundary is shared, spend stays per user, manual reset preserves boundary', (t) => {
  const { db, repo, plan, a, b, raw, time } = setup(t)
  repo.settle('r1', a, 12)
  repo.settle('r2', b, 23)
  assert.equal(repo.progress(raw(a)).weekly_reset_at, new Date(boundary).toISOString())
  assert.equal(repo.progress(raw(b)).weekly_reset_at, new Date(boundary).toISOString())
  assert.equal(repo.progress(raw(a)).weekly_used, 12)
  assert.equal(repo.progress(raw(b)).weekly_used, 23)
  time(initial + 1000)
  repo.update(a, { action: 'reset' }, 'admin')
  assert.equal(repo.progress(raw(a)).weekly_used, 0)
  assert.equal(repo.progress(raw(b)).weekly_used, 23)
  assert.equal(repo.progress(raw(a)).weekly_reset_at, new Date(boundary).toISOString())
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custom_subscription_ledger').get().n, 2)
  const before = raw(a).expires_at
  repo.update(a, { action: 'renew', days: 2 }, 'admin')
  assert.notEqual(raw(a).expires_at, before)
  assert.equal(repo.progress(raw(a)).weekly_reset_at, new Date(boundary).toISOString())
  repo.savePlan({ weekly_reset_mode: 'independent' }, 'admin', plan.id)
  assert.equal(repo.progress(raw(a)).weekly_reset_at, new Date(initial + 1000 + WEEK_MS).toISOString())
})

test('expired or missing upstream reset never fabricates a new window; fresh snapshot resumes after restart', (t) => {
  const { db, repo, plan, a, raw, time, setReset } = setup(t)
  repo.settle('before', a, 7)
  setReset(null)
  assert.equal(repo.progress(raw(a)).weekly_sync_status, 'cached')
  time(boundary)
  assert.equal(repo.progress(raw(a)).weekly_used, 7)
  assert.equal(repo.progress(raw(a)).weekly_sync_status, 'waiting')
  assert.throws(
    () => repo.reserve({ user_id: 'a', group_id: plan.id }, 'denied', { model: 'claude-haiku-4-5', max_tokens: 1 }),
    (e) => e.code === 'subscription_window_pending',
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custom_subscription_reservations').get().n, 0)
  setReset(String((boundary + WEEK_MS) / 1000))
  const restarted = new SubscriptionsRepo(db)
  assert.equal(restarted.progress(raw(a)).weekly_used, 0)
  assert.equal(restarted.progress(raw(a)).weekly_sync_status, 'synced')
  repo.settle('late-settlement', a, 3)
  assert.equal(restarted.progress(raw(a)).weekly_used, 3)
  assert.equal(restarted.progress(raw(a)).weekly_reset_at, new Date(boundary + WEEK_MS).toISOString())
})

test('changing deadline within a current window never clears consumption', (t) => {
  const { repo, a, raw, setReset } = setup(t)
  repo.settle('before', a, 12)
  setReset(new Date(boundary + 3600000).toISOString())
  const progress = repo.progress(raw(a))
  assert.equal(progress.weekly_used, 12)
  assert.equal(progress.weekly_reset_at, new Date(boundary + 3600000).toISOString())
})

test('invalid reference, missing reset, wrong platform and changed account cannot silently grant quota', (t) => {
  const { db, repo, plan, a, raw } = setup(t)
  for (const patch of [
    { weekly_reset_mode: 'invalid' },
    { weekly_reset_vm_id: 'missing' },
    { weekly_reset_vm_id: 'Other' },
    { vm_ids: ['Other'] },
    { platform: 'openai' },
  ])
    assert.throws(() => repo.savePlan(patch, 'admin', plan.id))
  assert.equal(repo.group(plan.id).weekly_reset_vm_id, 'Claude')
  db.prepare('UPDATE vms SET vm_json=? WHERE id=?').run(
    JSON.stringify({ id: 'Claude', claude: { account_uuid: 'replacement' } }),
    'Claude',
  )
  assert.equal(repo.progress(raw(a)).weekly_sync_status, 'waiting')
  assert.throws(() => repo.savePlan({ weekly_reset_vm_id: 'Claude' }, 'admin', plan.id))
})

test('source only uses current Claude account total weekly reset, accepts official ISO fallback', (t) => {
  const { db } = setup(t)
  const accounts = new AccountsRepo(db),
    acc = accounts.get('account-Claude')
  acc.unified = {
    headers: { '7d': { reset: 'expired' }, '5h': { reset: boundary / 1000 } },
    official: { '7d': { reset: new Date(boundary).toISOString(), utilization: 0.7 } },
    seven_day_sonnet: { reset: new Date(boundary + 123).toISOString() },
  }
  accounts.save(acc)
  assert.equal(readClaudeWeeklyReset(db, 'Claude').end, boundary)
  acc.unified = {
    headers: { '5h': { reset: boundary / 1000 } },
    seven_day_sonnet: { reset: new Date(boundary + 123).toISOString() },
  }
  accounts.save(acc)
  assert.equal(readClaudeWeeklyReset(db, 'Claude').end, null)
})
