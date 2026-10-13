import crypto from 'node:crypto'
import { buildCodexUsageView } from './codex-usage.mjs'

export const CODEX_WEEK_MS = 7 * 86400000
function claims(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString())
  } catch {
    return {}
  }
}
// Hash stable account identity, never a rotating access/refresh token.
export function codexWeeklyAccountKey(vm, credential = {}) {
  const token = claims(credential.id_token || credential.access_token)
  const auth =
    token['https://api.openai.com/auth'] || claims(credential.access_token)['https://api.openai.com/auth'] || {}
  const account = credential.chatgpt_account_id || auth.chatgpt_account_id || vm.codex?.chatgpt_account_id
  const subject = auth.user_id || token.sub || credential.email || vm.codex?.email
  if (!account && !subject) return null
  return (
    'codex:' +
    crypto
      .createHash('sha256')
      .update(JSON.stringify([account || '', subject || '']))
      .digest('hex')
  )
}

export function codexWeeklySample(extra, now = Date.now()) {
  const view = buildCodexUsageView(extra || {})
  const { limits, snapshot } = view
  const at = Date.parse(extra?.codex_subscription_sample_started_at || snapshot.updated_at)
  const end = Date.parse(limits.reset_7d_at)
  const used = limits.used_7d_percent
  if (
    limits.window_7d_minutes !== 10080 ||
    used == null ||
    used < 0 ||
    used > 100 ||
    !Number.isFinite(at) ||
    at > now + 60000 ||
    !Number.isFinite(end) ||
    end <= at ||
    end > at + CODEX_WEEK_MS + 60000
  )
    return null
  return { at, end, used }
}

// Called on BOTH quota queries and inference headers, before the new snapshot replaces the old one.
// All state lives with the slot metadata and survives restarts; duplicate/older snapshots cannot replay a reset.
export function observeCodexWeekly(vm, incoming, credential, { now = Date.now(), confirmedReset = null } = {}) {
  const account = codexWeeklyAccountKey(vm, credential)
  const sample = codexWeeklySample(incoming, now)
  if (!account || !sample) return vm.codex?.subscription_weekly || null
  const stored = vm.codex?.subscription_weekly
  const previous = stored?.account === account ? stored : null
  if (previous && sample.at <= previous.at) return previous
  const next = {
    account,
    ...sample,
    resetAt: previous?.resetAt || null,
    resetKind: previous?.resetKind || null,
    zeroCandidate: null,
  }
  const receiptAt = Date.parse(confirmedReset?.at)
  const receiptValid =
    confirmedReset?.account === account &&
    confirmedReset.windows >= 2 &&
    Number.isFinite(receiptAt) &&
    sample.at >= receiptAt &&
    sample.used === 0
  if (receiptValid && receiptAt > (next.resetAt || 0)) {
    next.resetAt = receiptAt
    next.resetKind = 'official_reset_credit'
  } else if (previous && sample.at < previous.end && sample.used === 0) {
    // A moved full-week boundary plus a real fall to zero identifies a new window.
    const inferredStart = sample.end - CODEX_WEEK_MS
    if (
      previous.used > 0 &&
      sample.end > previous.end + 60000 &&
      inferredStart >= previous.at - 60000 &&
      inferredStart <= sample.at + 60000
    ) {
      next.resetAt = Math.min(sample.at, Math.max(previous.at, inferredStart))
      next.resetKind = 'official_window_restarted'
    } else if (previous.zeroCandidate && sample.at >= previous.zeroCandidate + 5000) {
      // Same deadline: require two separately dated zero snapshots, not two reads of one cache entry.
      next.resetAt = previous.zeroCandidate
      next.resetKind = 'official_zero_confirmed'
    } else if (previous.used > 0 || previous.zeroCandidate) {
      next.zeroCandidate = previous.zeroCandidate || sample.at
    }
  }
  return next
}
