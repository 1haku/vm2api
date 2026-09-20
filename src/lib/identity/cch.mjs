/**
 * Official Claude Code cch: xxh64(body_with_cch=00000, seed) & 0xfffff.
 * Billing is assembled with the placeholder; seal after the outbound body is final.
 */
import { xxh64 } from './xxh64.mjs'

export const CCH_PLACEHOLDER = '00000'
export const CCH_XXH64_SEED = 0x6e52736ac806831en

export function computeClaudeCodeCch(bodyBytes) {
  const h = xxh64(bodyBytes, CCH_XXH64_SEED)
  return (h & 0xfffffn).toString(16).padStart(5, '0')
}

function sealCchString(raw) {
  const text = String(raw ?? '')
  if (!/x-anthropic-billing-header:[^"]*cch=00000/i.test(text)) return text
  const cch = computeClaudeCodeCch(Buffer.from(text, 'utf8'))
  return text.replace(/(x-anthropic-billing-header:[^"]*?cch=)00000/gi, `$1${cch}`)
}

/** Hash compact JSON of `body` (cch=00000) and write the 5-hex digest back. */
export function sealClaudeCodeCch(body) {
  if (body == null) return body
  if (typeof body === 'string') return sealCchString(body)
  if (typeof body !== 'object') return body
  const raw = JSON.stringify(body)
  const sealed = sealCchString(raw)
  if (sealed === raw) return body
  return JSON.parse(sealed)
}
