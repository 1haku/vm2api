import { VmsRepo } from '../db/repos/vms-repo.mjs'
import { AccountsRepo } from '../db/repos/accounts-repo.mjs'
import { headerWindow, officialWindow, parseResetMs } from '../pool/quota-window.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'

export const WEEK_MS = 7 * 86400000
const iso = (ms) => new Date(ms).toISOString()

// Use the same account and 7d total window as the Claude slot card, not 5h or model-specific limits.
export function readClaudeWeeklyReset(db, vmId, now = Date.now()) {
  if (db.prepare('SELECT owner_user_id FROM vms WHERE id=?').get(vmId)?.owner_user_id) return null
  const record = new VmsRepo(db).get(vmId)
  const vm = record?.vm
  if (!vm || vm.owner_user_id || isCodexVm(vm)) return null
  const accountId = vm.claude?.account_uuid || vm.account_uuid
  if (!accountId) return null
  const account = new AccountsRepo(db).get(accountId)
  const unified = account?.vm_id === vmId ? account.unified : {}
  const candidates = [headerWindow(unified, '7d').reset, officialWindow(unified, '7d').reset]
  const end = candidates.map(parseResetMs).find((ms) => Number.isFinite(ms) && ms > now && ms <= now + WEEK_MS + 60000)
  return { accountId, end: end ?? null }
}

export function resolveWeeklyWindow(db, plan, now = Date.now(), readSource = readClaudeWeeklyReset) {
  if (plan.weekly_reset_mode !== 'slot') return null
  const source = readSource(db, plan.weekly_reset_vm_id, now)
  const oldStart = Date.parse(plan.weekly_window_start)
  const oldEnd = Date.parse(plan.weekly_window_end)
  const sameAccount = !!source && source.accountId === plan.weekly_source_account
  let start = oldStart,
    end = oldEnd
  if (sameAccount && Number.isFinite(oldStart) && Number.isFinite(oldEnd) && source.end && source.end !== oldEnd) {
    // A changed deadline within the current window must not refund consumed quota.
    // A confirmed next window starts at the previous boundary (or the latest week after downtime).
    start = now >= oldEnd ? Math.max(oldEnd, source.end - WEEK_MS) : oldStart
    end = source.end
    db.prepare('UPDATE custom_subscription_plans SET weekly_window_start=?,weekly_window_end=? WHERE group_id=?').run(
      iso(start),
      iso(end),
      plan.group_id ?? plan.id,
    )
  }
  const ready = sameAccount && Number.isFinite(start) && Number.isFinite(end) && end > now
  return { start, end, status: ready ? (source.end ? 'synced' : 'cached') : 'waiting' }
}
