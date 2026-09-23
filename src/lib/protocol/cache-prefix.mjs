/**
 * Detects when a continuing conversation stops being a byte prefix of its
 * previous turn. Anthropic only reads cache up to the first changed byte, so a
 * break here is a full rewrite upstream even when the request succeeds. The
 * token counts alone never showed this (1.3.29–1.3.32 read 0 for days).
 */
import { createHash } from 'node:crypto'

const SESSION_LIMIT = 10_000
/** Longest cache TTL; an older turn cannot be read anyway. */
const SESSION_IDLE_MS = 60 * 60_000
const sessions = new Map()

function digest(value) {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16)
}

function firstDivergence(previous, current) {
  const shared = Math.min(previous.length, current.length)
  for (let i = 0; i < shared; i++) {
    if (previous[i] !== current[i]) return i
  }
  return previous.length > current.length ? shared : -1
}

/**
 * Record `body` as the latest turn of `sessionKey` and compare it with the
 * previous one. Returns null for an unkeyed request; otherwise the turn number
 * and the first section (tools → system → messages) that no longer matches.
 */
export function trackCachePrefix(sessionKey, body, now = Date.now()) {
  const key = String(sessionKey || '').trim()
  if (!key || !body || typeof body !== 'object') return null
  const current = {
    tools: digest(body.tools),
    system: digest(body.system),
    messages: (Array.isArray(body.messages) ? body.messages : []).map(digest),
  }
  const hit = sessions.get(key)
  const previous = hit && now - hit.at < SESSION_IDLE_MS ? hit : null
  sessions.delete(key)
  sessions.set(key, { ...current, turn: (previous?.turn || 0) + 1, at: now })
  if (sessions.size > SESSION_LIMIT) sessions.delete(sessions.keys().next().value)
  const turn = (previous?.turn || 0) + 1
  if (!previous) return { turn, break: null }
  if (previous.tools !== current.tools) return { turn, break: { section: 'tools' } }
  if (previous.system !== current.system) return { turn, break: { section: 'system' } }
  const index = firstDivergence(previous.messages, current.messages)
  if (index >= 0) return { turn, break: { section: 'messages', index } }
  return { turn, break: null }
}

export function clearCachePrefixSessions() {
  sessions.clear()
}
