/**
 * Host-owned Claude OAuth/setup-token refresh (sub2api RefreshIfNeeded).
 * Slot processes only read credentials.json.
 */
import { boundProxyUrl } from '../vm/egress.mjs'
import { resolveImportProxy } from '../vm/proxy-resolve.mjs'
import {
  needsRefresh,
  readWorkerCredentialFile,
  writeWorkerCredentialFile,
  REFRESH_SKEW_MS,
} from './oauth-credentials.mjs'
import { isApiKeyMode } from './credential-mode.mjs'

export const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

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

async function postRefresh({ refreshToken, proxyUrl, fetchImpl }) {
  const { default: fetch } = await import('node-fetch')
  const { SocksProxyAgent } = await import('socks-proxy-agent')
  const agent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined
  const impl = fetchImpl || fetch
  const res = await impl(CLAUDE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
    }),
    agent,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(String(data.error_description || data.error || `refresh http ${res.status}`).slice(0, 300))
    err.code = String(data.error || 'credential_refresh_failed')
    err.status = res.status
    err.retryable = res.status === 429 || res.status >= 500
    if (err.code === 'invalid_grant' || err.code === 'invalid_refresh_token' || res.status === 400) {
      err.retryable = false
    }
    throw err
  }
  const access = String(data.access_token || '').trim()
  if (!access) {
    const err = new Error('refresh response has no access_token')
    err.code = 'missing_access_token'
    throw err
  }
  const expiresIn = Number(data.expires_in) || 28800
  return {
    access_token: access,
    refresh_token: String(data.refresh_token || refreshToken).trim(),
    expires_at: Date.now() + expiresIn * 1000,
    scope: data.scope || null,
  }
}

/**
 * @returns {{ ok: boolean, refreshed?: boolean, refresh_class?: string, credential?: object, error?: object }}
 */
export async function refreshSlotCredentialIfNeeded({
  homeDir,
  vm,
  proxyPool,
  proxyUrl,
  force = false,
  now = Date.now(),
  fetchImpl,
} = {}) {
  const cred = readWorkerCredentialFile(homeDir)
  if (!cred) {
    return { ok: false, error: { code: 'credential_required', message: 'slot has no credential file' } }
  }
  if (isApiKeyMode(cred.type || cred.mode)) {
    return { ok: true, refreshed: false, refresh_class: 'already_fresh', credential: cred }
  }
  const refresh = String(cred.refresh_token || '').trim()
  if (!refresh) {
    return {
      ok: cred.type === 'setup-token',
      refreshed: false,
      refresh_class: cred.type === 'setup-token' ? 'already_fresh' : 'fatal',
      credential: cred,
      error:
        cred.type === 'setup-token'
          ? undefined
          : { code: 'refresh_token_missing', message: 'credential has no refresh token' },
    }
  }
  if (!force && !needsRefresh(cred.expires_at, now, REFRESH_SKEW_MS)) {
    return { ok: true, refreshed: false, refresh_class: 'already_fresh', credential: cred }
  }
  const hop = hopProxy({ vm, proxyPool, proxyUrl })
  if (!hop.ok) {
    return { ok: false, error: { code: 'proxy_required', message: 'slot SOCKS5 is required for token refresh' } }
  }
  try {
    const next = await postRefresh({
      refreshToken: refresh,
      proxyUrl: hop.direct ? '' : hop.proxyUrl,
      fetchImpl,
    })
    const merged = {
      ...cred,
      access_token: next.access_token,
      refresh_token: next.refresh_token,
      expires_at: next.expires_at,
      scope: next.scope || cred.scope,
    }
    writeWorkerCredentialFile(homeDir, merged)
    return {
      ok: true,
      refreshed: true,
      refresh_class: 'rotated',
      credential: readWorkerCredentialFile(homeDir) || merged,
    }
  } catch (error) {
    return {
      ok: false,
      refresh_class: error.retryable === false ? 'fatal' : 'retryable',
      error: { code: error.code || 'credential_refresh_failed', message: String(error.message || error).slice(0, 300) },
    }
  }
}
