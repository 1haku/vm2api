import { VmsRepo } from '../db/repos/vms-repo.mjs'
import { AccountsRepo } from '../db/repos/accounts-repo.mjs'
import { headerWindow, officialWindow, parseResetMs } from '../pool/quota-window.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { readCodexAccounts } from '../vm/codex-slot.mjs'
import { codexWeeklyAccountKey, codexWeeklySample } from '../protocol/codex-weekly-reset.mjs'

export const WEEK_MS = 7 * 86400000
const iso = (ms) => new Date(ms).toISOString()

// Use the same account and 7d total window as the Claude slot card, not 5h or model-specific limits.
export function readClaudeWeeklyReset(db, vmId, now = Date.now()) {
  if (db.prepare('SELECT owner_user_id FROM vms WHERE id=?').get(vmId)?.owner_user_id) return null
  const record = new VmsRepo(db).get(vmId)
  const vm = record?.vm
  if (!vm || vm.owner_user_id || isCodexVm(vm)) return null
  // Token-only imports can lack an account UUID. The scheduler and quota probe
  // store their snapshot under the slot ID; never select an arbitrary old row
  // by vm_id or fall back when an explicit current account UUID is present.
  const accountId = vm.claude?.account_uuid || vm.account_uuid || vm.id
  if (!accountId) return null
  const account = new AccountsRepo(db).get(accountId)
  const unified = account?.vm_id === vmId ? account.unified : {}
  const candidates = [headerWindow(unified, '7d').reset, officialWindow(unified, '7d').reset]
  const end = candidates.map(parseResetMs).find((ms) => Number.isFinite(ms) && ms > now && ms <= now + WEEK_MS + 60000)
  return { accountId, end: end ?? null }
}

export function readOfficialWeeklyReset(db, vmId, now = Date.now()) {
  if (db.prepare('SELECT owner_user_id FROM vms WHERE id=?').get(vmId)?.owner_user_id) return null
  const vm = new VmsRepo(db).get(vmId)?.vm
  if (!vm) return null
  if (!isCodexVm(vm)) return readClaudeWeeklyReset(db, vmId, now)
  const credential = readCodexAccounts(process.env.KIN_PROJECT_ROOT || process.cwd(), vmId)[0]
  const accountId = codexWeeklyAccountKey(vm, credential)
  if (!accountId) return null
  const tracked = vm.codex?.subscription_weekly
  const sample =
    tracked?.account === accountId ? tracked : codexWeeklySample(vm.codex?.extra || vm.codex?.usage || {}, now)
  // Never use a previous account's quota after credentials are replaced.
  if (tracked && tracked.account !== accountId) return { accountId, end: null }
  const end = sample?.end > now && sample.end <= now + WEEK_MS + 60000 ? sample.end : null
  return { accountId, end, resetAt: tracked?.resetAt || null, resetKind: tracked?.resetKind || null }
}

export function resolveWeeklyWindow(db, plan, now = Date.now(), readSource = readOfficialWeeklyReset) {
  if (plan.weekly_reset_mode !== 'slot') return null
  const source = readSource(db, plan.weekly_reset_vm_id, now)
  const oldStart = Date.parse(plan.weekly_window_start)
  const oldEnd = Date.parse(plan.weekly_window_end)
  const sameAccount = !!source && source.accountId === plan.weekly_source_account
  let start = oldStart,
    end = oldEnd
  const earlyReset = sameAccount && source.resetAt > oldStart && source.resetAt <= now && source.resetAt < oldEnd
  if (
    sameAccount &&
    Number.isFinite(oldStart) &&
    Number.isFinite(oldEnd) &&
    source.end &&
    (source.end !== oldEnd || earlyReset)
  ) {
    // A changed deadline within the current window must not refund consumed quota.
    // A confirmed next window starts at the previous boundary (or the latest week after downtime).
    start = earlyReset
      ? Math.max(source.resetAt, now >= oldEnd ? source.end - WEEK_MS : oldStart)
      : now >= oldEnd
        ? Math.max(oldEnd, source.end - WEEK_MS)
        : oldStart
    end = source.end
    db.prepare('UPDATE custom_subscription_plans SET weekly_window_start=?,weekly_window_end=? WHERE group_id=?').run(
      iso(start),
      iso(end),
      plan.group_id ?? plan.id,
    )
    if (earlyReset)
      db.prepare('INSERT INTO custom_subscription_events(group_id,action,detail,created_at) VALUES(?,?,?,?)').run(
        plan.group_id ?? plan.id,
        'official_weekly_reset',
        JSON.stringify({
          vm_id: plan.weekly_reset_vm_id,
          reason: source.resetKind,
          previous_start: iso(oldStart),
          start: iso(start),
          next_reset: iso(end),
        }),
        iso(now),
      )
  }
  const ready = sameAccount && Number.isFinite(start) && Number.isFinite(end) && end > now
  return { start, end, status: ready ? (source.end ? 'synced' : 'cached') : 'waiting' }
}
