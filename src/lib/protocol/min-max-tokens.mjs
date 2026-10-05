/**
 * max_tokens floor for the Anthropic hop (sub2api apicompat minMaxOutputTokens).
 * Health checks and third-party pings send 1..16; very small values end the
 * hop before any visible text. A missing max_tokens is left to the defaults.
 * Cache refreshes intentionally request almost no output and keep their cap.
 */
import { hasPromptCacheControl } from './cache-ttl.mjs'

export const DEFAULT_MIN_MAX_TOKENS = Object.freeze({ enabled: true, value: 128 })

export function normalizeMinMaxTokensConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const n = Math.round(Number(src.value))
  return {
    enabled: src.enabled !== false,
    value: Number.isFinite(n) && n >= 1 ? Math.min(n, 4096) : DEFAULT_MIN_MAX_TOKENS.value,
  }
}

export function applyMinMaxTokens(body, raw) {
  if (!body || typeof body !== 'object') return body
  const cfg = normalizeMinMaxTokensConfig(raw)
  if (!cfg.enabled) return body
  const current = Number(body.max_tokens)
  if (body.max_tokens == null || !Number.isFinite(current)) return body
  const floor = hasPromptCacheControl(body) ? 1 : cfg.value
  let next = Math.max(current, floor)
  const thinking = body.thinking
  const budget = Number(thinking?.budget_tokens)
  // Upstream rejects max_tokens <= budget_tokens on enabled thinking.
  if (String(thinking?.type || '').toLowerCase() === 'enabled' && Number.isFinite(budget) && next <= budget) {
    next = budget + floor
  }
  return next === current ? body : { ...body, max_tokens: next }
}
