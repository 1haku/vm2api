/**
 * Download the published linux amd64 kin-kernel from a GitHub Release.
 * Callers install it with replaceKernelBinary and sync slots; this module
 * only fetches bytes. Redirects stay on GitHub hosts so a release payload
 * cannot point the control plane at an internal URL.
 */
import { inspectLinuxAmd64Elf } from '../vm/wrap-cli-runtime.mjs'
import { GITHUB_REPO, githubApiHeaders, isReleaseTag, normalizeTag, normalizeVersion } from './release.mjs'

export const KERNEL_RELEASE_ASSET = 'kin-kernel'
export const MAX_KERNEL_DOWNLOAD_BYTES = 32 * 1024 * 1024

const META_TIMEOUT_MS = 8000
const DOWNLOAD_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 3

function coded(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

export function kernelReleaseHttpStatus(code) {
  if (code === 'github_http_404') return 404
  if (
    code === 'kernel_tag_invalid' ||
    code === 'kernel_asset_missing' ||
    code === 'kernel_asset_url' ||
    code === 'kernel_too_large' ||
    code === 'kernel_redirect_blocked' ||
    code === 'kernel_too_small' ||
    code === 'kernel_empty' ||
    String(code || '').startsWith('kernel_not_')
  ) {
    return 400
  }
  return 502
}

export function isAllowedKernelUrl(raw, { redirect = false } = {}) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  if (url.hostname === 'api.github.com') {
    return new RegExp(`^/repos/${GITHUB_REPO}/releases/(?:latest|tags/v\\d+\\.\\d+\\.\\d+|assets/\\d+)$`).test(
      url.pathname,
    )
  }
  if (url.hostname === 'github.com') {
    return new RegExp(`^/${GITHUB_REPO}/releases/download/v\\d+\\.\\d+\\.\\d+/${KERNEL_RELEASE_ASSET}$`).test(
      url.pathname,
    )
  }
  return (
    redirect &&
    (url.hostname === 'release-assets.githubusercontent.com' || url.hostname === 'objects.githubusercontent.com')
  )
}

export function selectKernelAsset(payload) {
  const tag = normalizeTag(payload?.tag_name || payload?.tag || '')
  if (!tag) return { ok: false, code: 'github_empty', error: 'GitHub Release 没有可用版本号' }
  const assets = Array.isArray(payload?.assets) ? payload.assets : []
  const asset = assets.find((item) => item && item.name === KERNEL_RELEASE_ASSET)
  if (!asset) return { ok: false, code: 'kernel_asset_missing', error: 'GitHub Release 里没有 kin-kernel' }
  const size = Number(asset.size)
  if (Number.isFinite(size) && size > MAX_KERNEL_DOWNLOAD_BYTES) {
    return { ok: false, code: 'kernel_too_large', error: 'kin-kernel 超过 32MB' }
  }
  const apiUrl = typeof asset.url === 'string' ? asset.url : ''
  const browserUrl = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
  const url = isAllowedKernelUrl(apiUrl) ? apiUrl : isAllowedKernelUrl(browserUrl) ? browserUrl : ''
  if (!url) return { ok: false, code: 'kernel_asset_url', error: 'kin-kernel 下载地址不是 GitHub Release' }
  return {
    ok: true,
    tag,
    version: normalizeVersion(tag),
    asset: KERNEL_RELEASE_ASSET,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    url,
  }
}

async function readCappedBody(res, maxBytes) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw coded('kernel_too_large', 'kin-kernel 超过 32MB')
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > maxBytes) throw coded('kernel_too_large', 'kin-kernel 超过 32MB')
    return buf
  }
  const reader = res.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > maxBytes) throw coded('kernel_too_large', 'kin-kernel 超过 32MB')
      chunks.push(chunk)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks, total)
}

async function fetchKernelBytes(startUrl, fetchImpl) {
  let current = startUrl
  let headers = githubApiHeaders('application/octet-stream')
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowedKernelUrl(current, { redirect: hop > 0 })) {
      throw coded('kernel_redirect_blocked', 'GitHub 跳转到了不允许的地址')
    }
    const res = await fetchImpl(current, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw coded('kernel_download_failed', 'GitHub 下载缺少跳转地址')
      current = new URL(loc, current).href
      headers = {
        Accept: 'application/octet-stream',
        'User-Agent': 'vm2api-release-check',
      }
      continue
    }
    if (!res.ok) throw coded('kernel_download_failed', `GitHub kernel 下载失败 (${res.status})`)
    return readCappedBody(res, MAX_KERNEL_DOWNLOAD_BYTES)
  }
  throw coded('kernel_redirect_blocked', 'GitHub 下载跳转过多')
}

export async function downloadReleaseKernel({ tag = '', fetchImpl = globalThis.fetch } = {}) {
  if (!fetchImpl) return { ok: false, code: 'fetch_unavailable', error: 'fetch unavailable' }
  const trimmed = String(tag || '').trim()
  let metaUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
  if (trimmed) {
    const normalized = normalizeTag(trimmed)
    if (!normalized || !isReleaseTag(normalized)) {
      return { ok: false, code: 'kernel_tag_invalid', error: 'Release tag 必须是 vX.Y.Z' }
    }
    metaUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${normalized}`
  }
  let payload
  try {
    const res = await fetchImpl(metaUrl, {
      headers: githubApiHeaders(),
      redirect: 'manual',
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    })
    if (res.status !== 200) {
      return {
        ok: false,
        code: `github_http_${res.status}`,
        error: `GitHub Release 查询失败 (${res.status})`,
      }
    }
    try {
      payload = await res.json()
    } catch {
      return { ok: false, code: 'github_bad_json', error: 'GitHub Release 响应不是 JSON' }
    }
  } catch (error) {
    return {
      ok: false,
      code: error?.code && error.code !== 'ABORT_ERR' ? error.code : 'github_unreachable',
      error: String(error?.message || error || 'GitHub 不可达').slice(0, 200),
    }
  }
  const picked = selectKernelAsset(payload)
  if (!picked.ok) return picked
  let bytes
  try {
    bytes = await fetchKernelBytes(picked.url, fetchImpl)
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'kernel_download_failed',
      error: String(error?.message || error || 'kernel download failed').slice(0, 200),
    }
  }
  const check = inspectLinuxAmd64Elf(bytes)
  if (!check.ok) return check
  return {
    ok: true,
    tag: picked.tag,
    version: picked.version,
    asset: picked.asset,
    size: bytes.length,
    bytes,
  }
}
