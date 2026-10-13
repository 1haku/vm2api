import crypto from 'node:crypto'
import { isIP } from 'node:net'

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const failure = (status, code, message) => ({ status, body: { ok: false, error: { type: 'auth', code, message } } })

// No forwarding headers are trusted here: the tunnel and LAN share this listener.
// Account limits remain separate even when clients share a proxy's socket address.
export function createPanelLoginProtection({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  const enabled = env.TURNSTILE_ENABLED === '1' || env.TURNSTILE_ENABLED === 'true'
  const sitekey = String(env.TURNSTILE_SITE_KEY || '').trim()
  const secret = String(env.TURNSTILE_SECRET || '').trim()
  const hostnames = [
    ...new Set(
      String(env.TURNSTILE_HOSTNAMES || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ]
  const ready =
    !enabled ||
    !!(
      sitekey &&
      secret &&
      hostnames.length &&
      hostnames.every((h) => !isIP(h) && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/.test(h))
    )
  const buckets = new Map()
  let lastSweep = 0
  function take(key, limit, windowMs) {
    const time = now()
    if (time - lastSweep >= 60_000) {
      for (const [k, b] of buckets) if (b.until <= time) buckets.delete(k)
      lastSweep = time
    }
    let b = buckets.get(key)
    if (!b || b.until <= time) {
      if (!b && buckets.size >= 10_000) return false
      b = { count: 0, until: time + windowMs }
      buckets.set(key, b)
    }
    return ++b.count <= limit
  }
  return {
    publicConfig() {
      return { enabled, ready, sitekey: enabled && ready ? sitekey : '', hostnames: enabled && ready ? hostnames : [] }
    },
    async check(req, body) {
      const account = crypto
        .createHash('sha256')
        .update(
          String(body.username || body.user || body.u || '')
            .trim()
            .toLowerCase(),
        )
        .digest('hex')
      if (
        !take('global', 300, 60_000) ||
        !take('ip:' + (req.socket?.remoteAddress || 'unknown'), 60, 60_000) ||
        !take('account:' + account, 10, 600_000)
      ) {
        return failure(429, 'login_rate_limited', '登录尝试过于频繁，请稍后重试')
      }
      if (!enabled) return null
      if (!ready) return failure(503, 'turnstile_unavailable', '登录验证暂不可用，请联系管理员')
      const token = body['cf-turnstile-response']
      if (typeof token !== 'string' || !token.trim() || token.length > 2048) {
        return failure(403, 'turnstile_required', '请先完成人机验证')
      }
      let result
      try {
        const response = await fetchImpl(SITEVERIFY, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(8000),
          // remoteip is optional. Do not submit an untrusted forwarded IP or the tunnel IP.
          body: new URLSearchParams({ secret, response: token }),
        })
        if (!response.ok) throw new Error('verification unavailable')
        result = await response.json()
      } catch {
        return failure(503, 'turnstile_unavailable', '验证服务暂不可用，请稍后重试')
      }
      if (result?.success !== true || result.action !== 'login' || !hostnames.includes(result.hostname)) {
        return failure(403, 'turnstile_failed', '人机验证失败或已过期，请重新验证')
      }
      return null
    },
  }
}
