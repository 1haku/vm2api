/**
 * Codex turn-state collect / inject. Ported from
 * https://github.com/446599/ccodex-rotate (account+model cache, 292/332,
 * node-bound). Uses the GPT slot SOCKS instead of a bundled mihomo pool.
 */
import { boundProxyUrl } from '../vm/egress.mjs'
import { CODEX_USER_AGENT, makeSocksFetch } from './codex-models.mjs'

export const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
export const CODEX_TURN_STATE_LENGTHS = Object.freeze([292, 332])
export const CODEX_ROTATE_NEED_GAP_MS = 30_000

export const DEFAULT_CODEX_ROTATE = Object.freeze({
  enabled: false,
  inject_state: true,
  auto_collect: true,
  state_lengths: [...CODEX_TURN_STATE_LENGTHS],
  state_ttl_seconds: 3600,
  probe_model: 'gpt-6-astra',
})

export function normalizeCodexRotate(raw = {}) {
  const lengths = Array.isArray(raw.state_lengths)
    ? raw.state_lengths.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : [...DEFAULT_CODEX_ROTATE.state_lengths]
  const ttl = Number(raw.state_ttl_seconds)
  return {
    enabled: raw.enabled === true,
    inject_state: raw.inject_state !== false,
    auto_collect: raw.auto_collect !== false,
    state_lengths: lengths.length ? lengths : [...DEFAULT_CODEX_ROTATE.state_lengths],
    state_ttl_seconds: Number.isFinite(ttl) && ttl >= 60 ? Math.floor(ttl) : DEFAULT_CODEX_ROTATE.state_ttl_seconds,
    probe_model: String(raw.probe_model || DEFAULT_CODEX_ROTATE.probe_model).trim() || DEFAULT_CODEX_ROTATE.probe_model,
  }
}

export function rotateFromRouting(routing = {}) {
  return normalizeCodexRotate(routing?.codex?.plugin?.rotate || routing?.plugin?.rotate || routing)
}

export function lengthAllowed(n, lengths) {
  if (!Array.isArray(lengths) || !lengths.length) return true
  return lengths.includes(Number(n))
}

export function rotateStoreKey(vmId, account, model) {
  return `${String(vmId || '')}\0${String(account || '')}\0${String(model || '').trim()}`
}

export function createTurnStateStore() {
  const entries = new Map()
  return {
    get(vmId, account, model, ttlSeconds, now = Date.now()) {
      const mid = String(model || '').trim()
      if (!mid) return null
      const key = rotateStoreKey(vmId, account, mid)
      const entry = entries.get(key)
      if (!entry) return null
      const ttlMs = Math.max(0, Number(ttlSeconds) || 0) * 1000
      if (ttlMs && now - entry.created > ttlMs) {
        entries.delete(key)
        return null
      }
      return { ...entry }
    },
    put(vmId, account, model, value, now = Date.now()) {
      const token = String(value || '').trim()
      const mid = String(model || '').trim()
      if (!token || !mid) return null
      const entry = {
        value: token,
        vmId: String(vmId || ''),
        account: String(account || ''),
        model: mid,
        length: token.length,
        created: now,
        hits: 0,
      }
      entries.set(rotateStoreKey(vmId, account, mid), entry)
      return { ...entry }
    },
    hit(vmId, account, model) {
      const entry = entries.get(rotateStoreKey(vmId, account, model))
      if (!entry) return 0
      entry.hits += 1
      return entry.hits
    },
    snapshot(ttlSeconds, now = Date.now()) {
      const ttlMs = Math.max(0, Number(ttlSeconds) || 0) * 1000
      const out = []
      for (const [key, entry] of entries) {
        if (ttlMs && now - entry.created > ttlMs) {
          entries.delete(key)
          continue
        }
        out.push({ ...entry })
      }
      return out
    },
    clear() {
      entries.clear()
    },
  }
}

const defaultStore = createTurnStateStore()
const lastNeed = new Map()

export function resetCodexRotateStore() {
  defaultStore.clear()
  lastNeed.clear()
}

export function getTurnState({ vmId, account, model, ttlSeconds, now, store } = {}) {
  return (store || defaultStore).get(vmId, account, model, ttlSeconds, now)
}

export function putTurnState({ vmId, account, model, value, now, store } = {}) {
  return (store || defaultStore).put(vmId, account, model, value, now)
}

export function extractTurnStateValue(source) {
  if (!source) return ''
  if (typeof source === 'string') return source.trim()
  if (typeof source.get === 'function') {
    return String(source.get('x-codex-turn-state') || source.get('X-Codex-Turn-State') || '').trim()
  }
  const headers = source.headers && typeof source.headers === 'object' ? source.headers : source
  if (typeof headers.get === 'function') {
    return String(headers.get('x-codex-turn-state') || headers.get('X-Codex-Turn-State') || '').trim()
  }
  return String(headers['x-codex-turn-state'] || headers['X-Codex-Turn-State'] || '').trim()
}

export function injectTurnState(body, value) {
  const next = body && typeof body === 'object' ? { ...body } : {}
  const token = String(value || '').trim()
  if (!token) return next
  next.turn_state = token
  const meta = next.client_metadata && typeof next.client_metadata === 'object' ? { ...next.client_metadata } : {}
  meta['x-codex-turn-state'] = token
  next.client_metadata = meta
  return next
}

export function applyCodexRotate({ body, routing, account, model, vmId, now, store } = {}) {
  const cfg = rotateFromRouting(routing)
  const nextBody = body && typeof body === 'object' ? { ...body } : {}
  if (!cfg.enabled || !cfg.inject_state) {
    return { body: nextBody, injected: false, cfg, needCollect: false }
  }
  const mid = String(model || nextBody.model || '').trim()
  const entry = getTurnState({
    vmId,
    account,
    model: mid,
    ttlSeconds: cfg.state_ttl_seconds,
    now,
    store,
  })
  if (entry && lengthAllowed(entry.length, cfg.state_lengths)) {
    ;(store || defaultStore).hit(vmId, account, mid)
    return {
      body: injectTurnState(nextBody, entry.value),
      injected: true,
      cfg,
      entry,
      needCollect: false,
    }
  }
  return { body: nextBody, injected: false, cfg, needCollect: cfg.auto_collect }
}

export function observeHopTurnState({ headers, account, model, vmId, lengths, now, store } = {}) {
  const value = extractTurnStateValue(headers)
  if (!value || !lengthAllowed(value.length, lengths || CODEX_TURN_STATE_LENGTHS)) return null
  return putTurnState({ vmId, account, model, value, now, store })
}

export function probeBody(model) {
  const mid = String(model || DEFAULT_CODEX_ROTATE.probe_model).replace(/"/g, '')
  return JSON.stringify({
    model: mid,
    instructions: 'You are a helper.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    stream: true,
    store: false,
    reasoning: { effort: 'low' },
    tools: [],
    parallel_tool_calls: false,
  })
}

export async function collectTurnState(opts = {}) {
  const token = String(opts.accessToken || '').trim()
  const model = String(opts.model || '').trim()
  if (!token || !model) return { ok: false, error: 'missing_auth_or_model', collected: false }
  const proxyUrl = String(opts.proxyUrl || '').trim()
  if (!proxyUrl && !opts.fetchImpl) return { ok: false, error: 'proxy_required', collected: false }
  const fetchFn = opts.fetchImpl || makeSocksFetch(proxyUrl, opts.timeoutMs || 12000)
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'openai-beta': 'responses=experimental',
    originator: 'codex_cli_rs',
    'user-agent': CODEX_USER_AGENT,
  }
  const account = String(opts.account || '').trim()
  if (account) headers['chatgpt-account-id'] = account
  try {
    const res = await fetchFn(CODEX_RESPONSES_URL, {
      method: 'POST',
      headers,
      body: probeBody(model),
    })
    const value = extractTurnStateValue(res)
    if (typeof res?.text === 'function') await res.text().catch(() => {})
    const status = Number(res?.status) || 0
    if (status === 403 || status >= 500) {
      return { ok: false, error: 'upstream_blocked', status, collected: false, length: 0 }
    }
    if (!value) return { ok: true, collected: false, status, length: 0 }
    const lengths = opts.lengths || DEFAULT_CODEX_ROTATE.state_lengths
    if (!lengthAllowed(value.length, lengths)) {
      return { ok: true, collected: false, status, length: value.length }
    }
    putTurnState({
      vmId: opts.vmId,
      account,
      model,
      value,
      now: opts.now,
      store: opts.store,
    })
    return { ok: true, collected: true, status, length: value.length }
  } catch (error) {
    const aborted = error?.name === 'AbortError' || /aborted/i.test(String(error?.message || error))
    return { ok: false, error: aborted ? 'timeout' : 'fetch_failed', collected: false }
  }
}

export function scheduleCodexRotateCollect(opts = {}) {
  const cfg = opts.cfg || DEFAULT_CODEX_ROTATE
  if (!cfg.enabled || cfg.auto_collect === false) return { scheduled: false }
  const model = String(opts.model || cfg.probe_model || '').trim()
  if (!model) return { scheduled: false }
  const key = rotateStoreKey(opts.vmId, opts.account, model)
  const now = opts.now || Date.now()
  const prev = lastNeed.get(key) || 0
  if (prev && now - prev < (opts.needGapMs ?? CODEX_ROTATE_NEED_GAP_MS)) {
    return { scheduled: false, reason: 'debounced' }
  }
  if (
    getTurnState({
      vmId: opts.vmId,
      account: opts.account,
      model,
      ttlSeconds: cfg.state_ttl_seconds,
      now,
      store: opts.store,
    })
  ) {
    return { scheduled: false, reason: 'cached' }
  }
  lastNeed.set(key, now)
  const collect = opts.collectImpl || collectTurnState
  const work = Promise.resolve(
    collect({
      accessToken: opts.accessToken,
      account: opts.account,
      model,
      vmId: opts.vmId,
      proxyUrl: opts.proxyUrl || boundProxyUrl(opts.vm?.proxy),
      lengths: cfg.state_lengths,
      timeoutMs: opts.timeoutMs || 12000,
      fetchImpl: opts.fetchImpl,
      now,
      store: opts.store,
    }),
  ).catch(() => {})
  return { scheduled: true, work }
}
