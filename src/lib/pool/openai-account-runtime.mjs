/**
 * Process-local OpenAI scheduling signals.
 * Failure EWMA matches codex-proxy-rs AccountFeedbackStats:
 * success/failure α=0.2, capacity reject α=0.4, 15 minute half-life.
 */

const FAILURE_ALPHA = 0.2
const CAPACITY_ALPHA = 0.4
const FAILURE_HALF_LIFE_MS = 15 * 60 * 1000

const slots = new Map()
const feedback = new Map()
let roundRobinCursor = 0

function slotOf(id) {
  const key = String(id || '')
  let slot = slots.get(key)
  if (!slot) {
    slot = { inFlight: 0, lastStartedAt: null }
    slots.set(key, slot)
  }
  return slot
}

function decayedFailure(entry, now) {
  if (!entry?.updatedAt) return entry?.value || 0
  const elapsed = Math.max(0, now - entry.updatedAt)
  return entry.value * 0.5 ** (elapsed / FAILURE_HALF_LIFE_MS)
}

export function openAIRuntimeSignals(id, now = Date.now()) {
  const key = String(id || '')
  const slot = slots.get(key)
  const entry = feedback.get(key)
  const failure = entry ? decayedFailure(entry, now) : 0
  const latency = entry?.latency
  return {
    inFlight: slot?.inFlight || 0,
    lastStartedAt: slot?.lastStartedAt ?? null,
    failureRateBps: Math.round(Math.min(1, Math.max(0, failure)) * 10_000),
    firstOutputLatencyMs: Number.isFinite(latency) && latency > 0 ? Math.round(latency) : null,
  }
}

export function readOpenAICursor() {
  return roundRobinCursor
}

export function bumpOpenAICursor() {
  roundRobinCursor += 1
  return roundRobinCursor
}

export function acquireOpenAISlot(id, now = Date.now()) {
  const slot = slotOf(id)
  slot.inFlight += 1
  slot.lastStartedAt = now
  return slot.inFlight
}

export function releaseOpenAISlot(id) {
  const key = String(id || '')
  const slot = slots.get(key)
  if (!slot) return 0
  slot.inFlight = Math.max(0, slot.inFlight - 1)
  return slot.inFlight
}

export function reportOpenAIAttempt(id, kind, firstOutputMs = null, now = Date.now()) {
  const key = String(id || '')
  if (!key) return
  const entry = feedback.get(key) || { value: 0, updatedAt: null, latency: null }
  const sample = kind === 'succeeded' ? 0 : 1
  const alpha = kind === 'capacity_rejected' ? CAPACITY_ALPHA : FAILURE_ALPHA
  const decayed = decayedFailure(entry, now)
  entry.value = alpha * sample + (1 - alpha) * decayed
  entry.updatedAt = now
  const latency = Number(firstOutputMs)
  if (Number.isFinite(latency) && latency > 0) {
    entry.latency = entry.latency == null ? latency : FAILURE_ALPHA * latency + (1 - FAILURE_ALPHA) * entry.latency
  }
  feedback.set(key, entry)
}

export function resetOpenAIAccountRuntime() {
  slots.clear()
  feedback.clear()
  roundRobinCursor = 0
}
