/**
 * Codex hop client gate. Official Codex CLI and OpenAI-compatible
 * third-party clients are allowed; Claude Code is rejected.
 */

const OFFICIAL_CODEX_UA = /(?:^|[^\w-])codex(?:_cli_rs|_cli|_exec|_vscode)?(?:\/|\s|$)/i
const OFFICIAL_CODEX_ORIGINATOR = /^codex(?:_cli_rs|_exec|_vscode)?$/i
const CLAUDE_CODE_UA = /claude-cli|claude-code|anthropic-ai\/sdk/i
const OPENAI_SDK_UA = /openai\/|openai-node|openai-python|ChatGPT-User/i

export function classifyCodexClient(headers = {}, body = {}, protocol = '') {
  const ua = String(headers['user-agent'] || headers['User-Agent'] || '')
  if (CLAUDE_CODE_UA.test(ua)) return 'claude_code'
  const originator = String(headers.originator || '')
  if (
    OFFICIAL_CODEX_UA.test(ua) ||
    OFFICIAL_CODEX_ORIGINATOR.test(originator) ||
    headers['x-codex-installation-id'] ||
    headers['session-id']
  ) {
    if (!CLAUDE_CODE_UA.test(ua)) return 'official_codex'
  }
  if (
    OPENAI_SDK_UA.test(ua) ||
    headers['openai-beta'] ||
    Array.isArray(body?.messages) ||
    body?.input != null ||
    String(protocol).startsWith('openai.')
  ) {
    return 'openai_compatible'
  }
  return 'unknown'
}

export function restrictCodexClient(headers, body, routing = {}, protocol = '') {
  const clients = routing.codex?.clients || routing.clients || {}
  const kind = classifyCodexClient(headers, body, protocol)
  if (clients[kind] === 'allow') return { ok: true, kind }
  return {
    ok: false,
    kind,
    code: 'client_not_allowed',
    message: `client '${kind}' is not allowed on the Codex hop`,
  }
}
