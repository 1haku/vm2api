/**
 * Host-owned Anthropic peek hops (count_tokens / usage / models).
 * Slot kernel only does inference; these use bound SOCKS + read-only AT.
 */
import { boundProxyUrl } from '../vm/egress.mjs'
import { resolveImportProxy } from '../vm/proxy-resolve.mjs'
import { readWorkerCredentialFile } from './oauth-credentials.mjs'
import { isApiKeyMode } from './credential-mode.mjs'
import { AUTH_SCHEME_BEARER, resolveAuthScheme } from './auth-scheme.mjs'
import { refreshSlotCredentialIfNeeded } from './host-token-refresh.mjs'

export const CLAUDE_API_BASE = 'https://api.anthropic.com'

function hopProxy({ vm, proxyPool, proxyUrl } = {}) {
  if (proxyUrl) {
    return { ok: true, proxyUrl: String(proxyUrl).replace(/^socks5:\/\//i, 'socks5h://'), direct: false }
  }
  const resolved = resolveImportProxy({ vm, proxyPool })
  if (resolved.ok && resolved.direct) return { ok: true, proxyUrl: '', direct: true }
  if (resolved.ok && resolved.proxyUrl) {
    return {
      ok: true,
      proxyUrl: String(resolved.proxyUrl).replace(/^socks5:\/\//i, 'socks5h://'),
      direct: false,
    }
  }
  const bound = boundProxyUrl(vm?.proxy) || ''
  if (bound) return { ok: true, proxyUrl: bound, direct: false }
  return { ok: false, proxyUrl: '', direct: false }
}

function headersToObject(headers) {
  const out = {}
  if (!headers) return out
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      out[String(key).toLowerCase()] = String(value)
    })
    return out
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value == null) continue
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value)
  }
  return out
}

function authHeaders(cred) {
  const token = String(cred.access_token || cred.api_key || '').trim()
  const scheme = resolveAuthScheme({
    mode: cred.type || cred.mode,
    auth_scheme: cred.auth_scheme,
  })
  if (scheme === AUTH_SCHEME_BEARER) return { authorization: `Bearer ${token}` }
  return { 'x-api-key': token }
}

/**
 * @returns {{ ok: boolean, status: number, body: object, headers: object, error?: object }}
 */
export async function hostAnthropicRequest({
  homeDir,
  vm,
  proxyPool,
  proxyUrl,
  method = 'GET',
  apiPath,
  body = null,
  headers = {},
  timeoutMs = 45000,
  fetchImpl,
  refresh = true,
} = {}) {
  if (refresh) {
    const rotated = await refreshSlotCredentialIfNeeded({ homeDir, vm, proxyPool, proxyUrl })
    if (!rotated.ok && rotated.error?.code && rotated.error.code !== 'already_fresh') {
      if (rotated.error.code !== 'refresh_token_missing') {
        return {
          ok: false,
          status: rotated.error.code === 'proxy_required' ? 400 : 502,
          body: { error: rotated.error },
          headers: {},
          error: rotated.error,
        }
      }
    }
  }
  const cred = readWorkerCredentialFile(homeDir)
  const token = String(cred?.access_token || cred?.api_key || '').trim()
  if (!token) {
    return {
      ok: false,
      status: 400,
      body: { error: { code: 'credential_required', message: 'slot has no access token' } },
      headers: {},
    }
  }
  const hop = hopProxy({ vm, proxyPool, proxyUrl })
  if (!hop.ok) {
    return {
      ok: false,
      status: 400,
      body: { error: { code: 'proxy_required', message: 'slot SOCKS5 is required for Anthropic hops' } },
      headers: {},
    }
  }
  const { default: fetch } = await import('node-fetch')
  const { SocksProxyAgent } = await import('socks-proxy-agent')
  const agent = hop.direct || !hop.proxyUrl ? undefined : new SocksProxyAgent(hop.proxyUrl)
  const impl = fetchImpl || fetch
  const hdr = {
    accept: 'application/json',
    'anthropic-version': '2023-06-01',
    ...authHeaders(cred),
  }
  for (const [key, value] of Object.entries(headers || {})) {
    if (value == null || value === '') continue
    const lower = String(key).toLowerCase()
    if (lower === 'authorization' || lower === 'x-api-key' || lower === 'cookie') continue
    hdr[lower] = String(value)
  }
  if (body != null && !hdr['content-type']) hdr['content-type'] = 'application/json'
  const path = String(apiPath || '').startsWith('/') ? apiPath : `/${apiPath}`
  let res
  try {
    const controller =
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
    res = await impl(`${CLAUDE_API_BASE}${path}`, {
      method,
      headers: hdr,
      body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      agent,
      signal: controller,
    })
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: { error: { code: 'upstream_transport_error', message: String(error.message || error).slice(0, 300) } },
      headers: {},
    }
  }
  const raw = await res.text().catch(() => '')
  let parsed = {}
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = { error: { message: raw.slice(0, 300) } }
  }
  return {
    ok: res.ok,
    status: res.status || 0,
    body: parsed,
    headers: headersToObject(res.headers),
    via: 'host-socks',
  }
}

export async function hostCountTokens(exec, { body, headers = {}, timeoutMs = 45000, fetchImpl } = {}) {
  return hostAnthropicRequest({
    homeDir: exec.homeDir,
    vm: exec.vm,
    method: 'POST',
    apiPath: '/v1/messages/count_tokens',
    body,
    headers,
    timeoutMs,
    fetchImpl,
    refresh: !isApiKeyMode(exec?.vm?.claude?.mode),
  })
}

export async function hostModels(exec, { timeoutMs = 30000, fetchImpl } = {}) {
  return hostAnthropicRequest({
    homeDir: exec.homeDir,
    vm: exec.vm,
    method: 'GET',
    apiPath: '/v1/models',
    headers: { accept: 'application/json' },
    timeoutMs,
    fetchImpl,
  })
}

export async function hostOauthUsage(exec, { timeoutMs = 30000, fetchImpl } = {}) {
  const cred = readWorkerCredentialFile(exec.homeDir)
  if (isApiKeyMode(cred?.type || cred?.mode || exec?.vm?.claude?.mode)) {
    return {
      ok: false,
      status: 400,
      body: { error: { code: 'usage_unsupported', message: 'console API key cannot call /api/oauth/usage' } },
      headers: {},
      via: 'host-socks',
    }
  }
  return hostAnthropicRequest({
    homeDir: exec.homeDir,
    vm: exec.vm,
    method: 'GET',
    apiPath: '/api/oauth/usage',
    headers: { accept: 'application/json', 'anthropic-beta': 'oauth-2025-04-20' },
    timeoutMs,
    fetchImpl,
  })
}
