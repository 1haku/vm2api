/**
 * Effective 5h / 7d windows for panel + scheduler.
 *
 * Official `/api/oauth/usage` often keeps utilization=1 + status=rejected after
 * a session rolls over, with `resets_at` already pointing at the *next* window.
 * That leftover must not mark the slot as 5h-full when this gateway has not
 * sent anything in the current window.
 */

export const WINDOW_5H_MS = 5 * 3600_000
export const WINDOW_7D_MS = 7 * 24 * 3600_000

export function parseResetMs(reset) {
  if (reset == null || reset === '') return NaN
  if (typeof reset === 'number' && Number.isFinite(reset)) {
    return reset < 10_000_000_000 ? reset * 1000 : reset
  }
  const str = String(reset).trim()
  if (!str) return NaN
  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = Number(str)
    if (!Number.isFinite(n) || n <= 0) return NaN
    return n < 10_000_000_000 ? n * 1000 : n
  }
  const parsed = Date.parse(str)
  return Number.isFinite(parsed) ? parsed : NaN
}

export function parseUsedAtMs(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

const OFFICIAL_SOURCES = new Set(['vm-oauth-usage', 'official-cc-usage'])

function windowHasData(window) {
  if (!window || typeof window !== 'object') return false
  return window.utilization != null || window.status || window.reset || window.resets_at
}

/** Official /usage window. Never falls back to Messages headers. */
export function officialWindow(unified = {}, key = '5h') {
  if (windowHasData(unified?.official?.[key])) return unified.official[key]
  const legacyOfficial =
    OFFICIAL_SOURCES.has(String(unified?.source || '')) ||
    OFFICIAL_SOURCES.has(String(unified?.last_probe?.source || ''))
  if (legacyOfficial && windowHasData(unified?.[key])) return unified[key]
  return { utilization: 0, reset: null, status: 'active' }
}

/** Live inference / CLI rate-limit headers (Extra). */
export function headerWindow(unified = {}, key = '5h') {
  if (windowHasData(unified?.headers?.[key])) return unified.headers[key]
  return { utilization: null, reset: null, status: null }
}

/** Header Extra for list/gate. Elapsed reset is 0 / active. */
export function headerWindowOrEmpty(unified = {}, key = '5h', { now = Date.now() } = {}) {
  const raw = headerWindow(unified, key)
  if (!windowHasData(raw)) return { utilization: null, reset: null, status: null }
  const resetMs = parseResetMs(raw.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) {
    return {
      utilization: 0,
      status: 'active',
      reset: raw.reset ?? null,
      stale: true,
      stale_reason: 'reset_elapsed',
    }
  }
  return {
    utilization: raw.utilization ?? null,
    reset: raw.reset ?? null,
    status: raw.status ?? null,
  }
}

export function wipeElapsedHeaderWindows(unified = {}, { now = Date.now() } = {}) {
  const headers = unified?.headers
  if (!headers || typeof headers !== 'object') return { headers, changed: false }
  let changed = false
  const next = { ...headers }
  for (const key of ['5h', '7d']) {
    const w = next[key]
    if (!windowHasData(w)) continue
    const resetMs = parseResetMs(w.reset)
    if (!Number.isFinite(resetMs) || resetMs > now) continue
    next[key] = {
      utilization: 0,
      status: 'active',
      reset: w.reset ?? null,
      stale: true,
      stale_reason: 'reset_elapsed',
    }
    changed = true
  }
  if (changed) {
    const liveRejected = ['5h', '7d'].some((key) => {
      const s = String(next[key]?.status || '').toLowerCase()
      return s === 'rejected' || s === 'rate_limited'
    })
    if (!liveRejected) next.exhausted_at = null
  }
  return { headers: next, changed }
}

/**
 * Extra 100% + future reset is often leftover after a rollover.
 * Clear only when last_used is before this Extra window started.
 */
export function leftoverClearHeaderWindows(unified = {}, { now = Date.now(), lastUsedAt = null } = {}) {
  const headers = unified?.headers
  if (!headers || typeof headers !== 'object') return { headers, changed: false }
  const usedAt = parseUsedAtMs(lastUsedAt)
  let changed = false
  const next = { ...headers }
  const durations = { '5h': WINDOW_5H_MS, '7d': WINDOW_7D_MS }
  for (const key of ['5h', '7d']) {
    const w = next[key]
    if (!windowHasData(w) || !isLimited(w.status, w.utilization)) continue
    const resetMs = parseResetMs(w.reset)
    if (!Number.isFinite(resetMs) || resetMs <= now) continue
    const windowStart = resetMs - durations[key]
    if (!usedAt || usedAt >= windowStart) continue
    next[key] = {
      utilization: 0,
      status: 'active',
      reset: w.reset ?? null,
      stale: true,
      stale_reason: 'header_no_in_window_usage',
    }
    changed = true
  }
  if (changed && !['5h', '7d'].some((key) => isRejectedStatus(next[key]?.status))) {
    next.exhausted_at = null
  }
  return { headers: next, changed }
}

/** List / capsule / gate numbers from Extra only. */
export function listQuotaFromHeaders(unified = {}, { now = Date.now() } = {}) {
  const wiped = wipeElapsedHeaderWindows(unified, { now }).headers || unified?.headers || {}
  const view = { ...unified, headers: wiped }
  const w5 = headerWindowOrEmpty(view, '5h', { now })
  const w7 = headerWindowOrEmpty(view, '7d', { now })
  const oi = wiped['7d_oi'] || unified?.['7d_oi'] || {}
  return {
    utilization_5h: w5.utilization != null ? Number(w5.utilization) : null,
    utilization_7d: w7.utilization != null ? Number(w7.utilization) : null,
    status_5h: w5.status || null,
    status_7d: w7.status || null,
    reset_5h: w5.reset || null,
    reset_7d: w7.reset || null,
    utilization_7d_oi: oi.utilization != null ? Number(oi.utilization) : null,
    status_7d_oi: oi.status || null,
    reset_7d_oi: oi.reset || null,
    '5h': w5,
    '7d': w7,
  }
}

/** Extra/ingest is 0–1; leftover official Settings numbers are 0–100. Never ×100 twice. */
export function toPercentUsed(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  if (n < 0) return 0
  if (n <= 1) return Math.round(n * 10000) / 100
  if (n > 100) return 100
  return n
}

export function publicUsageWindow(window = {}) {
  const utilization = window?.utilization != null ? toPercentUsed(window.utilization) : null
  const status = window?.status || null
  const resets_at = window?.reset || window?.resets_at || null
  if (utilization == null && !status && !resets_at) return null
  return { utilization, status, resets_at }
}

export function usageWindowsEmpty(listed = {}) {
  const five = listed['5h'] || {
    utilization: listed.utilization_5h,
    status: listed.status_5h,
    reset: listed.reset_5h,
  }
  const seven = listed['7d'] || {
    utilization: listed.utilization_7d,
    status: listed.status_7d,
    reset: listed.reset_7d,
  }
  return !publicUsageWindow(five) && !publicUsageWindow(seven)
}

export function projectRateWindows(unified = {}) {
  return {
    ...unified,
    '5h': officialWindow(unified, '5h'),
    '7d': officialWindow(unified, '7d'),
  }
}

function isRejectedStatus(status) {
  const s = String(status || '').toLowerCase()
  return s === 'rejected' || s === 'rate_limited'
}

/** Header samples are 0–1. Official Settings leftovers are 0–100. */
function utilRatio(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return n > 1.5 ? n / 100 : n
}

function isPercentReading(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 1.5
}

/** True 429 / CLI rejected on headers, until reset or official /usage clears it.
 * Percent 26 stored next to a rejected flag is 26%, not a full window.
 */
export function headerHardBlocked(unified = {}, key = '5h', now = Date.now()) {
  const h = headerWindow(unified, key)
  if (!isRejectedStatus(h.status)) return false
  const ratio = utilRatio(h.utilization)
  if (isPercentReading(h.utilization) && ratio != null && ratio < 1) return false
  const resetMs = parseResetMs(h.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) return false
  return true
}

function isLimited(status, utilization) {
  const ratio = utilRatio(utilization)
  if (isPercentReading(utilization) && ratio != null && ratio < 1) return false
  const s = String(status || '').toLowerCase()
  if (s === 'rejected' || s === 'rate_limited') return true
  return ratio != null && ratio >= 1
}

/** Live Extra that is still allowed. Elapsed reset or rejected/100% is not live. */
export function extraIsLiveOpen(window = {}, now = Date.now()) {
  if (!windowHasData(window)) return false
  const resetMs = parseResetMs(window.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) return false
  return !isLimited(window.status, window.utilization)
}

function cleared(window, reason) {
  return {
    utilization: 0,
    status: 'active',
    reset: window?.reset ?? null,
    stale: true,
    stale_reason: reason,
  }
}

/**
 * @param {{ utilization?: number, status?: string, reset?: string } | null} window
 * @param {{ now?: number, lastUsedAt?: number|string|null, source?: string|null, durationMs?: number }} [opts]
 */
export function effectiveRateWindow(
  window = {},
  { now = Date.now(), lastUsedAt = null, source = null, durationMs = WINDOW_5H_MS } = {},
) {
  const utilization = window?.utilization != null ? Number(window.utilization) : null
  const status = window?.status ?? null
  const resetMs = parseResetMs(window?.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) {
    return cleared(window, 'reset_elapsed')
  }
  if (!isLimited(status, utilization)) {
    return {
      utilization: Number.isFinite(utilization) ? utilization : (window?.utilization ?? null),
      status,
      reset: window?.reset ?? null,
      stale: false,
    }
  }
  // Live inference headers / Claude Code rate_limit_event stay authoritative.
  // Official /usage can leave sticky 100% after a real rollover. Only clear
  // that leftover when last_used proves the current window has no gateway
  // traffic. Missing last_used used to clear a live 限制 and reschedule it.
  const fromProbe = OFFICIAL_SOURCES.has(String(source || ''))
  if (!fromProbe) {
    return {
      utilization: Number.isFinite(utilization) ? utilization : (window?.utilization ?? null),
      status,
      reset: window?.reset ?? null,
      stale: false,
    }
  }
  const usedAt = parseUsedAtMs(lastUsedAt)
  const windowStart = Number.isFinite(resetMs) ? resetMs - durationMs : NaN
  if (Number.isFinite(windowStart) && usedAt && usedAt < windowStart) {
    return cleared(window, 'probe_no_in_window_usage')
  }
  return {
    utilization: Number.isFinite(utilization) ? utilization : (window?.utilization ?? null),
    status,
    reset: window?.reset ?? null,
    stale: false,
  }
}

/** Raw official 5h/7d 限制 that has not reached its reset. */
export function isOfficialWindowLimited(window = {}, { now = Date.now() } = {}) {
  if (!isLimited(window?.status, window?.utilization)) return false
  const resetMs = parseResetMs(window?.reset)
  if (Number.isFinite(resetMs) && resetMs <= now) return false
  return true
}

export function applyEffectiveWindows(unified = {}, { now = Date.now(), lastUsedAt = null, source = null } = {}) {
  const projected = projectRateWindows(unified)
  const src = source || projected.source || null
  return {
    ...projected,
    '5h': {
      ...(projected['5h'] || {}),
      ...effectiveRateWindow(projected['5h'] || {}, {
        now,
        lastUsedAt,
        source: src,
        durationMs: WINDOW_5H_MS,
      }),
    },
    '7d': {
      ...(projected['7d'] || {}),
      ...effectiveRateWindow(projected['7d'] || {}, {
        now,
        lastUsedAt,
        source: src,
        durationMs: WINDOW_7D_MS,
      }),
    },
  }
}
