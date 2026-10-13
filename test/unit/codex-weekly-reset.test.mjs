import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { persistCodexQuotaSnapshot } from '../../src/lib/vm/codex-slot.mjs'
import { persistCodexUsage } from '../../src/lib/vm/vm-registry.mjs'
import {
  codexWeeklySample,
  codexWeeklyAccountKey,
  observeCodexWeekly,
  CODEX_WEEK_MS as WEEK,
} from '../../src/lib/protocol/codex-weekly-reset.mjs'

const t0 = Date.parse('2026-10-13T08:00:00Z'),
  oldEnd = t0 + 3 * 86400000
const extra = (at, used, end = oldEnd) => ({
  codex_primary_used_percent: 7,
  codex_primary_window_minutes: 300,
  codex_primary_reset_at: new Date(at + 3600000).toISOString(),
  codex_secondary_used_percent: used,
  codex_secondary_window_minutes: 10080,
  codex_secondary_reset_at: new Date(end).toISOString(),
  codex_usage_updated_at: new Date(at).toISOString(),
})
const slot = () => ({ codex: { chatgpt_account_id: 'account-A' } })

test('quota and inference writers share persisted observations and reject delayed pre-reset requests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-week-observe-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  const file = path.join(root, 'vms', 'Codex.json')
  fs.writeFileSync(file, JSON.stringify({ id: 'Codex', platform: 'openai', ...slot() }))
  const now = Date.now(),
    end = now + 86400000
  const first = extra(now - 20000, 70, end)
  persistCodexQuotaSnapshot(root, 'Codex', { extra: first })
  persistCodexUsage(root, 'Codex', { extra: extra(now - 10000, 0, end), now })
  assert.equal(JSON.parse(fs.readFileSync(file)).codex.subscription_weekly.resetAt, null)
  persistCodexQuotaSnapshot(root, 'Codex', { extra: extra(now, 0, end) })
  assert.equal(JSON.parse(fs.readFileSync(file)).codex.subscription_weekly.resetAt, now - 10000)
  persistCodexUsage(root, 'Codex', {
    extra: { ...extra(now + 1, 70, end), codex_subscription_sample_started_at: new Date(now - 15000).toISOString() },
    now,
  })
  const after = JSON.parse(fs.readFileSync(file)).codex.subscription_weekly
  assert.equal(after.used, 0)
  assert.equal(after.resetAt, now - 10000)
})
const feed = (vm, at, used, end, options = {}) =>
  (vm.codex.subscription_weekly = observeCodexWeekly(vm, extra(at, used, end), {}, { now: at, ...options }))

test('Codex identifies the 7d window by duration rather than primary/secondary order', () => {
  assert.deepEqual(codexWeeklySample(extra(t0, 72), t0), { at: t0, used: 72, end: oldEnd })
  assert.equal(codexWeeklySample({ ...extra(t0, 72), codex_secondary_window_minutes: 1440 }, t0), null)
  assert.equal(codexWeeklySample({ ...extra(t0, 72), codex_usage_updated_at: null }, t0), null)
  assert.equal(codexWeeklySample({ ...extra(t0, 72), codex_secondary_used_percent: null }, t0), null)
})

test('same-deadline early zero requires two fresh samples and remembers one reset across restart', () => {
  let vm = slot()
  feed(vm, t0, 72)
  const first = feed(vm, t0 + 10000, 0)
  assert.equal(first.resetAt, null)
  assert.equal(first.zeroCandidate, t0 + 10000)
  const duplicate = feed(vm, t0 + 10000, 0)
  assert.deepEqual(duplicate, first)
  feed(vm, t0 + 12000, 0)
  assert.equal(vm.codex.subscription_weekly.resetAt, null)
  feed(vm, t0 + 16000, 0)
  assert.equal(vm.codex.subscription_weekly.resetAt, t0 + 10000)
  assert.equal(vm.codex.subscription_weekly.resetKind, 'official_zero_confirmed')
  vm = JSON.parse(JSON.stringify(vm))
  feed(vm, t0 + 30000, 0)
  assert.equal(vm.codex.subscription_weekly.resetAt, t0 + 10000)
  const saved = structuredClone(vm.codex.subscription_weekly)
  feed(vm, t0 + 5000, 80)
  assert.deepEqual(vm.codex.subscription_weekly, saved)
})

test('new full-week deadline and drop to zero follow the early new window without waiting', () => {
  const vm = slot()
  feed(vm, t0, 72)
  const at = t0 + 10000
  feed(vm, at, 0, at + WEEK)
  assert.equal(vm.codex.subscription_weekly.resetAt, at)
  assert.equal(vm.codex.subscription_weekly.end, at + WEEK)
})

test('a correction, clock drift, partial 5h update or natural rollover never creates an early reset', () => {
  const vm = slot()
  feed(vm, t0, 72)
  feed(vm, t0 + 10000, 71, oldEnd + 1000)
  assert.equal(vm.codex.subscription_weekly.resetAt, null)
  feed(vm, t0 + 20000, 0, oldEnd)
  feed(vm, t0 + 30000, 70, oldEnd)
  assert.equal(vm.codex.subscription_weekly.zeroCandidate, null)
  const before = structuredClone(vm.codex.subscription_weekly)
  vm.codex.subscription_weekly = observeCodexWeekly(
    vm,
    {
      codex_primary_used_percent: 0,
      codex_primary_window_minutes: 300,
      codex_usage_updated_at: new Date(t0 + 40000).toISOString(),
    },
    {},
    { now: t0 + 40000 },
  )
  assert.deepEqual(vm.codex.subscription_weekly, before)
  feed(vm, oldEnd, 0, oldEnd + WEEK)
  assert.equal(vm.codex.subscription_weekly.resetAt, null)
})

test('a confirmed reset receipt only applies to the same account, zero weekly usage and multiple reset windows', () => {
  for (const windows of [0, 1, 2]) {
    const vm = slot()
    feed(vm, t0, 72)
    const account = codexWeeklyAccountKey(vm)
    feed(vm, t0 + 11000, 0, oldEnd, { confirmedReset: { at: new Date(t0 + 10000).toISOString(), account, windows } })
    assert.equal(vm.codex.subscription_weekly.resetAt, windows === 2 ? t0 + 10000 : null)
  }
  const vm = slot()
  feed(vm, t0, 72)
  feed(vm, t0 + 11000, 0, oldEnd, {
    confirmedReset: { at: new Date(t0 + 10000).toISOString(), account: 'other', windows: 2 },
  })
  assert.equal(vm.codex.subscription_weekly.resetAt, null)
  vm.codex.chatgpt_account_id = 'account-B'
  feed(vm, t0 + 22000, 0)
  assert.equal(vm.codex.subscription_weekly.zeroCandidate, null)
  assert.equal(vm.codex.subscription_weekly.resetAt, null)
})

test('JWT identity stays stable through token refresh but distinguishes replacement users', () => {
  const jwt = (p) => 'header.' + Buffer.from(JSON.stringify(p)).toString('base64url') + '.sig'
  const a = codexWeeklyAccountKey({}, { id_token: jwt({ sub: 'user-A', exp: 1 }) })
  assert.equal(a, codexWeeklyAccountKey({}, { id_token: jwt({ sub: 'user-A', exp: 2 }) }))
  assert.notEqual(a, codexWeeklyAccountKey({}, { id_token: jwt({ sub: 'user-B', exp: 2 }) }))
  assert.equal(codexWeeklyAccountKey({}, { id: 'codex', access_token: 'opaque' }), null)
})
