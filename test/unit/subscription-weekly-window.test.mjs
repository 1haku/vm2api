import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { SubscriptionsRepo } from '../../src/lib/db/repos/subscriptions-repo.mjs'
import { readClaudeWeeklyReset, WEEK_MS } from '../../src/lib/admin/subscription-weekly-window.mjs'
import { VmsRepo } from '../../src/lib/db/repos/vms-repo.mjs'
import { observeCodexWeekly } from '../../src/lib/protocol/codex-weekly-reset.mjs'

test('Codex early official reset clears daily and weekly spend once while preserving ledger and reservations', (t) => {
  const { db, repo, time } = setup(t)
  const vms = new VmsRepo(db)
  const vm = { id: 'Codex', platform: 'openai', codex: { chatgpt_account_id: 'test-account' } }
  const sample = (at, used, end = boundary) => {
    const extra = {
      codex_primary_window_minutes: 10080,
      codex_primary_used_percent: used,
      codex_primary_reset_at: new Date(end).toISOString(),
      codex_usage_updated_at: new Date(at).toISOString(),
    }
    vm.codex.subscription_weekly = observeCodexWeekly(vm, extra, {}, { now: at })
    vm.codex.extra = extra
    vms.upsertFromVmJson(vm)
  }
  sample(initial, 75)
  const groups = ['Gold', 'Silver'].map((name) =>
    repo.savePlan(
      {
        name,
        platform: 'openai',
        vm_ids: ['Codex'],
        daily_limit_usd: 100,
        weekly_limit_usd: 100,
        weekly_reset_mode: 'slot',
        weekly_reset_vm_id: 'Codex',
      },
      'admin',
    ),
  )
  const subscriptions = groups.map((g) => repo.assign({ group_id: g.id, user_ids: ['a'] }, 'admin')[0])
  for (const [i, id] of subscriptions.entries()) repo.settle('codex-old-' + i, id, 80)
  db.prepare(
    'INSERT INTO custom_subscription_reservations(request_id,subscription_id,amount,created_at) VALUES(?,?,?,?)',
  ).run('still-running', subscriptions[0], 2, new Date(initial).toISOString())
  const raw = (id) => db.prepare('SELECT * FROM custom_user_subscriptions WHERE id=?').get(id)
  for (const id of subscriptions) assert.equal(repo.progress(raw(id)).weekly_used, 80)
  time(initial + 10000)
  sample(initial + 10000, 0)
  assert.equal(repo.progress(raw(subscriptions[0])).weekly_used, 80)
  assert.equal(repo.progress(raw(subscriptions[0])).daily_used, 80)
  time(initial + 16000)
  sample(initial + 16000, 0)
  for (const id of subscriptions) {
    const p = repo.progress(raw(id))
    assert.equal(p.weekly_used, 0)
    assert.equal(p.daily_used, 0)
    assert.equal(p.weekly_reset_at, new Date(boundary).toISOString())
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM custom_subscription_events WHERE action='official_weekly_reset'").get().n,
    2,
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custom_subscription_reservations').get().n, 1)
  repo.settle('still-running', subscriptions[0], 1.5)
  const restarted = new SubscriptionsRepo(db)
  assert.equal(restarted.progress(raw(subscriptions[0])).weekly_used, 1.5)
  assert.equal(restarted.progress(raw(subscriptions[0])).daily_used, 1.5)
  time(initial + 30000)
  sample(initial + 30000, 0)
  assert.equal(restarted.progress(raw(subscriptions[0])).weekly_used, 1.5)
  assert.equal(restarted.progress(raw(subscriptions[0])).daily_used, 1.5)
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM custom_subscription_events WHERE action='official_weekly_reset'").get().n,
    2,
  )
  time(initial + 40000)
  sample(initial + 40000, 9)
  time(initial + 50000)
  sample(initial + 50000, 0, initial + 50000 + WEEK_MS)
  assert.equal(restarted.progress(raw(subscriptions[0])).weekly_used, 0)
  assert.equal(restarted.progress(raw(subscriptions[0])).daily_used, 0)
  assert.equal(
    restarted.progress(raw(subscriptions[0])).weekly_reset_at,
    new Date(initial + 50000 + WEEK_MS).toISOString(),
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custom_subscription_ledger').get().n, 3)
})

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
  const beforeDaily = repo.progress(raw(a))
  repo.update(a, { action: 'reset_daily' }, 'admin')
  assert.equal(repo.progress(raw(a)).daily_used, 0)
  assert.equal(repo.progress(raw(a)).weekly_used, 12)
  assert.equal(repo.progress(raw(a)).weekly_reset_at, beforeDaily.weekly_reset_at)
  assert.equal(repo.progress(raw(a)).daily_reset_at, beforeDaily.daily_reset_at)
  assert.equal(repo.progress(raw(b)).daily_used, 23)
  time(initial + 1000)
  repo.update(a, { action: 'reset' }, 'admin')
  assert.equal(repo.progress(raw(a)).weekly_used, 0)
  assert.equal(repo.progress(raw(a)).daily_used, 0)
  assert.equal(repo.progress(raw(b)).weekly_used, 23)
  assert.equal(repo.progress(raw(b)).daily_used, 23)
  assert.equal(repo.progress(raw(a)).weekly_reset_at, new Date(boundary).toISOString())
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custom_subscription_ledger').get().n, 2)
  repo.settle('after-manual-reset-same-ms', a, 4)
  assert.equal(repo.progress(raw(a)).daily_used, 4)
  assert.equal(repo.progress(raw(a)).weekly_used, 4)
  const before = raw(a).expires_at
  repo.update(a, { action: 'renew', days: 2 }, 'admin')
  assert.notEqual(raw(a).expires_at, before)
  assert.equal(repo.progress(raw(a)).weekly_reset_at, new Date(boundary).toISOString())
  repo.savePlan({ weekly_reset_mode: 'independent' }, 'admin', plan.id)
  assert.equal(repo.progress(raw(a)).weekly_reset_at, new Date(initial + 1000 + WEEK_MS).toISOString())
})

test('expired or missing upstream reset never fabricates a new window; fresh snapshot resumes after restart', (t) => {
  const { db, repo, plan, a, raw, time, setReset } = setup(t)
  time(boundary - 60000)
  repo.settle('before', a, 7)
  assert.equal(repo.progress(raw(a)).daily_used, 7)
  assert.equal(repo.progress(raw(a)).daily_reset_at, new Date(boundary).toISOString())
  setReset(null)
  assert.equal(repo.progress(raw(a)).weekly_sync_status, 'cached')
  time(boundary)
  assert.equal(repo.progress(raw(a)).weekly_used, 7)
  assert.equal(repo.progress(raw(a)).daily_used, 7)
  assert.equal(repo.progress(raw(a)).weekly_sync_status, 'waiting')
  assert.throws(
    () => repo.reserve({ user_id: 'a', group_id: plan.id }, 'denied', { model: 'claude-haiku-4-5', max_tokens: 1 }),
    (e) => e.code === 'subscription_window_pending',
  )
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custom_subscription_reservations').get().n, 0)
  setReset(String((boundary + WEEK_MS) / 1000))
  const restarted = new SubscriptionsRepo(db)
  assert.equal(restarted.progress(raw(a)).weekly_used, 0)
  assert.equal(restarted.progress(raw(a)).daily_used, 0)
  assert.equal(restarted.progress(raw(a)).weekly_sync_status, 'synced')
  repo.settle('late-settlement', a, 3)
  assert.equal(restarted.progress(raw(a)).weekly_used, 3)
  assert.equal(restarted.progress(raw(a)).daily_used, 3)
  assert.equal(restarted.progress(raw(a)).weekly_reset_at, new Date(boundary + WEEK_MS).toISOString())
  time(Date.parse('2026-10-14T16:00:00Z'))
  assert.equal(restarted.progress(raw(a)).daily_used, 0)
  assert.equal(restarted.progress(raw(a)).weekly_used, 3)
})

test('changing deadline within a current window never clears consumption', (t) => {
  const { repo, a, raw, setReset } = setup(t)
  repo.settle('before', a, 12)
  setReset(new Date(boundary + 3600000).toISOString())
  const progress = repo.progress(raw(a))
  assert.equal(progress.weekly_used, 12)
  assert.equal(progress.daily_used, 12)
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
