/**
 * routing.compatibility.claude_code_only — sub2api's group `claude_code_only`, made strict.
 * On: Anthropic-platform models accept only the official Claude Code family.
 * Callers gate on the detected platform first; OpenAI-platform models never reach this.
 */
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { isOfficialClaudeUa } from './official-claude-ua.mjs'
import { parseUserId } from './identity-rewrite.mjs'
import {
  eachSystemText,
  inboundHasOpenAIToolShape,
  isOfficialClaudeCodeTraffic,
  looksLikeOhMyPiSystem,
} from './crs-persona.mjs'

const CLAUDE_CODE_BETA = 'claude-code-20250219'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UA_VERSION_RE = /^claude-cli\/(\d+\.\d+\.\d+)/i
const BILLING_VERSION_RE = /x-anthropic-billing-header:[^\n]*\bcc_version=(\d+\.\d+\.\d+)/i

export function claudeCodeOnlyFromRouting(routing) {
  return routing?.compatibility?.claude_code_only === true
}

function headerText(headers, key) {
  return String(headers?.[key] ?? '').trim()
}

/**
 * Headers the CLI sends on every Messages and count_tokens call (captured from 2.1.280).
 * A UA alone is one string to copy; this set comes from the Stainless SDK plus the
 * CLI's own session header. Relays rewrite them, and a relayed body is just as easy to
 * forge, so the gate does not admit relayed traffic at all.
 */
export function hasClaudeCodeClientHeaders(headers = {}) {
  if (!isOfficialClaudeUa(headerText(headers, 'user-agent'))) return false
  if (headerText(headers, 'x-app').toLowerCase() !== 'cli') return false
  if (!headerText(headers, 'anthropic-version')) return false
  const betas = headerText(headers, 'anthropic-beta')
    .split(',')
    .map((token) => token.trim())
  if (!betas.includes(CLAUDE_CODE_BETA)) return false
  if (headerText(headers, 'x-stainless-lang').toLowerCase() !== 'js') return false
  if (!headerText(headers, 'x-stainless-runtime') || !headerText(headers, 'x-stainless-package-version')) return false
  return UUID_RE.test(headerText(headers, 'x-claude-code-session-id'))
}

/** The CLI stamps one session id into both the header and metadata.user_id. */
function sessionHeaderMatchesUserId(headers, body) {
  const session = headerText(headers, 'x-claude-code-session-id').toLowerCase()
  const parsed = parseUserId(body?.metadata?.user_id)
  if (!parsed) return false
  return [parsed.session_id, parsed.parent_session_id, parsed.root_session_id].some(
    (id) => id && String(id).trim().toLowerCase() === session,
  )
}

/** UA and billing block come from the same build constant; child prompts carry no billing block. */
function billingVersionMatchesUa(headers, body) {
  const uaVersion = UA_VERSION_RE.exec(headerText(headers, 'user-agent'))?.[1]
  for (const text of eachSystemText(body?.system)) {
    const billed = BILLING_VERSION_RE.exec(text)?.[1]
    if (billed) return billed === uaVersion
  }
  return true
}

/**
 * Direct Claude Code only: client header set, official system + user_id (same recognition
 * the persona path uses), session id agreeing across header and body, billing version
 * agreeing with the UA. count_tokens bodies carry only model/messages/tools, so the header
 * set is all there is to check. No UA-only exceptions: a `max_tokens: 1` probe must look
 * like the CLI too.
 */
export function isClaudeCodeFamilyRequest(headers = {}, body = {}, { countTokens = false } = {}) {
  if (looksLikeOhMyPiSystem(body?.system) || inboundHasOpenAIToolShape(body)) return false
  if (!hasClaudeCodeClientHeaders(headers)) return false
  if (countTokens) return true
  return (
    isOfficialClaudeCodeTraffic(headers, body) &&
    sessionHeaderMatchesUserId(headers, body) &&
    billingVersionMatchesUa(headers, body)
  )
}

export function claudeCodeOnlyError() {
  return makeError({
    type: ErrorType.PERMISSION,
    code: ErrorCode.CLAUDE_CODE_ONLY,
    message: '当前仅允许官方 Claude Code 客户端调用 Claude 模型',
    status: 403,
  })
}
