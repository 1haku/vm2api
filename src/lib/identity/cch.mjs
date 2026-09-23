/**
 * Official Claude Code 2.1.280 cch.
 * Hash a surgical edit of the original JSON text, not a re-serialized object.
 * The first `cch=` goes back to `00000`. Every `"model":"..."` value is cleared.
 * `"fallbacks":[...]`, `"fallback_credit_token":"..."`, and a numeric
 * `"max_tokens"` are cut out, including the adjacent comma.
 * Seed `0x4D659218E32A3268` is the ELF immediate, same as 2.1.177.
 * Low 20 bits, 5 lowercase hex. The bytes on the wire keep the real fields.
 */
import { xxh64 } from './xxh64.mjs'

export const CCH_PLACEHOLDER = '00000'
export const CCH_XXH64_SEED = 0x4d659218e32a3268n

function cut(text, start, end) {
  if (end < text.length && text[end] === ',') end += 1
  else if (start > 0 && text[start - 1] === ',') start -= 1
  return text.slice(0, start) + text.slice(end)
}

function clearModelValues(text) {
  const needle = '"model":"'
  const out = []
  let i = 0
  while (true) {
    const j = text.indexOf(needle, i)
    if (j < 0) {
      out.push(text.slice(i))
      break
    }
    let k = j + needle.length
    while (k < text.length) {
      if (text[k] === '\\' && k + 1 < text.length) {
        k += 2
        continue
      }
      if (text[k] === '"') break
      k += 1
    }
    out.push(text.slice(i, j + needle.length))
    i = k
  }
  return out.join('')
}

function stripFallbacks(text) {
  const key = '"fallbacks":['
  const j = text.indexOf(key)
  if (j < 0) return text
  let i = j + key.length - 1
  let depth = 0
  let inStr = false
  let esc = false
  while (i < text.length) {
    const c = text[i]
    if (inStr) {
      esc = !esc || c !== '\\' ? !esc && c === '\\' : false
      if (c === '"' && !esc) inStr = false
      else if (c === '\\') esc = !esc
      else esc = false
    } else if (c === '"') inStr = true
    else if (c === '[') depth += 1
    else if (c === ']') {
      depth -= 1
      if (depth === 0) return cut(text, j, i + 1)
    }
    i += 1
  }
  return text
}

function stripFallbackCreditToken(text) {
  const key = '"fallback_credit_token":"'
  const j = text.indexOf(key)
  if (j < 0) return text
  let k = j + key.length
  while (k < text.length) {
    if (text[k] === '\\' && k + 1 < text.length) {
      k += 2
      continue
    }
    if (text[k] === '"') return cut(text, j, k + 1)
    k += 1
  }
  return text
}

function stripMaxTokens(text) {
  const key = '"max_tokens":'
  const j = text.indexOf(key)
  if (j < 0) return text
  let k = j + key.length
  if (k >= text.length || !/\d/.test(text[k])) return text
  while (k < text.length && /\d/.test(text[k])) k += 1
  return cut(text, j, k)
}

export function projectClaudeCodeCchText(raw) {
  const source = String(raw ?? '')
  if (!/cch=[0-9a-f]{5}/.test(source)) throw new Error('billing cch not found')
  const replaced = source.replace(/cch=[0-9a-f]{5}/, 'cch=00000')
  return stripMaxTokens(stripFallbackCreditToken(stripFallbacks(clearModelValues(replaced))))
}

export function computeClaudeCodeCch(bodyBytes) {
  const h = xxh64(bodyBytes, CCH_XXH64_SEED)
  return (h & 0xfffffn).toString(16).padStart(5, '0')
}

function sealCchString(raw) {
  const text = String(raw ?? '')
  if (!/x-anthropic-billing-header:[^"]*cch=00000/i.test(text)) return text
  const cch = computeClaudeCodeCch(Buffer.from(projectClaudeCodeCchText(text), 'utf8'))
  return text.replace(/(x-anthropic-billing-header:[^"]*?cch=)00000/gi, `$1${cch}`)
}

/** Hash the 2.1.280 text projection of `body` and write the 5-hex digest back. */
export function sealClaudeCodeCch(body) {
  if (body == null) return body
  if (typeof body === 'string') return sealCchString(body)
  if (typeof body !== 'object') return body
  const raw = JSON.stringify(body)
  const sealed = sealCchString(raw)
  if (sealed === raw) return body
  return JSON.parse(sealed)
}
