/**
 * routing.compatibility.claude_code_only — sub2api's group `claude_code_only`.
 * On: Anthropic-platform models accept only the official Claude Code family.
 * Callers gate on the detected platform first; OpenAI-platform models never reach this.
 */
import { makeError, ErrorType, ErrorCode } from '../core/errors.mjs'
import { isOfficialClaudeUa } from './official-claude-ua.mjs'
import {
  detectProxiedOfficialCcFromRouting,
  isOfficialClaudeCodeTraffic,
  isProxiedOfficialClaudeCode,
  looksLikeOhMyPiSystem,
} from './crs-persona.mjs'

export function claudeCodeOnlyFromRouting(routing) {
  return routing?.compatibility?.claude_code_only === true
}

/**
 * Same recognition the persona / intercept path uses, so the gate never disagrees
 * with how the request would be treated once admitted. The UA-only exceptions follow
 * sub2api: the CLI's `max_tokens: 1` probes and count_tokens carry no official
 * system or user_id, and one output token or a token count is worthless to an abuser.
 */
export function isClaudeCodeFamilyRequest(headers = {}, body = {}, { routing = {}, countTokens = false } = {}) {
  if (isOfficialClaudeCodeTraffic(headers, body)) return true
  if (detectProxiedOfficialCcFromRouting(routing) && isProxiedOfficialClaudeCode(body, headers)) return true
  if (!isOfficialClaudeUa(headers['user-agent'] || headers['User-Agent'] || '')) return false
  if (looksLikeOhMyPiSystem(body?.system)) return false
  return countTokens || body?.max_tokens === 1
}

export function claudeCodeOnlyError() {
  return makeError({
    type: ErrorType.PERMISSION,
    code: ErrorCode.CLAUDE_CODE_ONLY,
    message: '当前仅允许官方 Claude Code 客户端调用 Claude 模型',
    status: 403,
  })
}
