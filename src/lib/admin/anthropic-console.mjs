/**
 * Panel Anthropic console.
 *
 * Direct mode calls one URL with the typed key. Scheduled mode reuses the API
 * endpoint picker (priority, prefix, alias, key round-robin) and that key's proxy.
 * The browser never dials upstream.
 */
import { normalizeAuthScheme, AUTH_SCHEME_BEARER, AUTH_SCHEME_X_API_KEY } from '../oauth/auth-scheme.mjs'
import { messagesUrl, trimBaseUrl, upstreamAuthHeaders } from '../pool/api-presets.mjs'
import { forwardApi, readApiJson } from '../transport/api-kernel-client.mjs'

export const ANTHROPIC_CONSOLE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_CONSOLE_TIMEOUT_MS = 60_000
const MAX_MESSAGE_CHARS = 16_000
const MAX_HEADER_PAIRS = 24

export function anthropicMessagesUrl(baseUrl) {
  const trimmed = trimBaseUrl(baseUrl) || ANTHROPIC_CONSOLE_URL
  if (!/^https?:\/\//i.test(trimmed)) {
    throw Object.assign(new Error('地址必须是 http 或 https'), { code: 'invalid_base_url', status: 400 })
  }
  return messagesUrl(trimmed)
}

export function anthropicProxyUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw Object.assign(new Error('代理地址无效'), { code: 'invalid_proxy_url', status: 400 })
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (!['http', 'https', 'socks5', 'socks5h'].includes(scheme)) {
    throw Object.assign(new Error('代理只支持 http、https、socks5'), { code: 'invalid_proxy_url', status: 400 })
  }
  if (!parsed.hostname || (scheme.startsWith('socks5') && !parsed.port)) {
    throw Object.assign(new Error('代理地址缺少主机或端口'), { code: 'invalid_proxy_url', status: 400 })
  }
  return value
}

function headerMap(raw) {
  if (raw == null || raw === '') return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw Object.assign(new Error('自定义头必须是对象'), { code: 'invalid_headers', status: 400 })
  }
  const out = {}
  const entries = Object.entries(raw)
  if (entries.length > MAX_HEADER_PAIRS) {
    throw Object.assign(new Error('自定义头过多'), { code: 'invalid_headers', status: 400 })
  }
  for (const [key, value] of entries) {
    const name = String(key || '').trim()
    if (!name || /[\r\n:]/.test(name) || /[\r\n]/.test(String(value ?? ''))) {
      throw Object.assign(new Error('自定义头含无效字符'), { code: 'invalid_headers', status: 400 })
    }
    out[name] = String(value ?? '')
  }
  return out
}

export function buildAnthropicConsoleRequest(input = {}, picked = null) {
  const scheduled = input.mode === 'scheduled'
  if (scheduled && !picked?.ok) {
    const error = Object.assign(new Error(picked?.message || '没有可用的 API 上游'), {
      code: picked?.code || 'api_pool_exhausted',
      status: picked?.code === 'model_not_found' ? 404 : 503,
    })
    throw error
  }

  const model = String((scheduled ? picked.upstream_model : input.model) || '').trim()
  if (!model) {
    throw Object.assign(new Error('先填模型'), { code: 'model_required', status: 400 })
  }
  const message = String(input.message ?? input.prompt ?? '').trim()
  if (!message) {
    throw Object.assign(new Error('先填消息'), { code: 'message_required', status: 400 })
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    throw Object.assign(new Error('消息过长'), { code: 'message_too_long', status: 400 })
  }
  const maxTokens = Number(input.max_tokens ?? input.maxTokens ?? 256)
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
    throw Object.assign(new Error('max_tokens 需要 1 到 8192 的整数'), { code: 'invalid_max_tokens', status: 400 })
  }

  const endpoint = scheduled ? picked.endpoint : null
  const key = scheduled ? String(picked.key?.api_key || '').trim() : String(input.api_key || input.apiKey || '').trim()
  if (!key) {
    throw Object.assign(new Error('先填 API key'), { code: 'api_key_required', status: 400 })
  }
  const scheme = normalizeAuthScheme(scheduled ? endpoint.auth_scheme : input.auth_scheme || input.authScheme) || AUTH_SCHEME_X_API_KEY
  const baseUrl = scheduled ? endpoint.base_url : input.base_url || input.baseUrl || ANTHROPIC_CONSOLE_URL
  const proxyUrl = scheduled ? anthropicProxyUrl(picked.key?.proxy_url) : anthropicProxyUrl(input.proxy_url || input.proxyUrl)
  const extra = headerMap(scheduled ? endpoint.headers : input.headers)
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...upstreamAuthHeaders('anthropic', key, { ...extra, auth_scheme: scheme }),
  }

  return {
    method: 'POST',
    url: anthropicMessagesUrl(baseUrl),
    headers,
    body: {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: message }],
    },
    proxyUrl,
    timeoutMs: ANTHROPIC_CONSOLE_TIMEOUT_MS,
    meta: {
      mode: scheduled ? 'scheduled' : 'direct',
      auth_scheme: scheme === AUTH_SCHEME_BEARER ? AUTH_SCHEME_BEARER : AUTH_SCHEME_X_API_KEY,
      endpoint_id: endpoint?.id || null,
      endpoint_name: endpoint?.name || null,
      key_id: scheduled ? picked.key?.id || null : null,
      requested_model: scheduled ? picked.requested_model : model,
      upstream_model: model,
      proxy: Boolean(proxyUrl),
    },
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('')
}

export function anthropicConsoleResult(upstream, meta) {
  const status = Number(upstream?.statusCode) || 502
  return readApiJson(upstream).then((payload) => {
    const body = payload && typeof payload === 'object' ? payload : { raw: String(payload ?? '') }
    const message = body?.error?.message || body?.message || ''
    return {
      ok: status >= 200 && status < 300,
      status,
      text: textFromContent(body?.content),
      error: status >= 400 ? String(message || `上游返回 ${status}`).slice(0, 500) : '',
      body,
      ...meta,
    }
  })
}

export async function runAnthropicConsole({ cfg, scheduler, input, forward = forwardApi }) {
  const scheduled = input?.mode === 'scheduled'
  const picked = scheduled ? scheduler?.pick?.(input?.model) : null
  if (scheduled && !scheduler?.pick) {
    throw Object.assign(new Error('API 调度不可用'), { code: 'scheduler_unavailable', status: 503 })
  }
  const request = buildAnthropicConsoleRequest(input || {}, picked)
  let upstream
  try {
    upstream = await forward({
      cfg,
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
      proxyUrl: request.proxyUrl,
      timeoutMs: request.timeoutMs,
    })
  } catch (error) {
    throw Object.assign(new Error(String(error?.message || error).slice(0, 300)), {
      code: error?.code || 'api_kernel_transport',
      status: 502,
    })
  }
  return anthropicConsoleResult(upstream, request.meta)
}
