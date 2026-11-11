import { corsHeadersForRequest } from './cors.mjs'

// Opt-in transport padding for JSON callers. Whitespace is valid before a JSON
// value, but committing it also commits HTTP 200. A later failure MUST abort the
// incomplete document, never send an error object disguised as a successful API
// response. The original status remains available to the usage logger.
const responses = new WeakMap()

export function startJsonKeepalive(
  req,
  res,
  { delayMs, intervalMs = 10_000, maxDurationMs = 600_000, rewriteEnabled = false } = {},
) {
  if (!(delayMs > 0) || res.headersSent || res.destroyed || res.writableEnded || responses.has(res)) return null
  const state = { committed: false, status: null, stopped: false, timers: [] }
  responses.set(res, state)
  const stop = () => {
    if (state.stopped) return
    state.stopped = true
    for (const timer of state.timers) clearTimeout(timer)
    res.off?.('close', stop)
    res.off?.('finish', stop)
  }
  state.stop = stop
  const schedule = (fn, ms) => {
    const timer = setTimeout(fn, ms)
    timer.unref?.()
    state.timers.push(timer)
  }
  const beat = () => {
    if (state.stopped || res.destroyed || res.writableEnded || (res.headersSent && !state.committed)) return stop()
    try {
      if (!state.committed) {
        const headers = corsHeadersForRequest(req, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          'x-accel-buffering': 'no',
          'x-kin-json-keepalive': '1',
          'x-kin-rewrite': rewriteEnabled ? 'on' : 'off',
        })
        if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
        res.writeHead(200)
        state.committed = true
        res.socket?.setNoDelay?.(true)
        res.flushHeaders?.()
      }
      // Do not accumulate padding behind a stalled/slow reader.
      if (!res.writableNeedDrain) res.write('\n')
      schedule(beat, Math.max(1, intervalMs))
    } catch {
      state.status = 499
      stop()
      res.destroy?.()
    }
  }
  res.once?.('close', stop)
  res.once?.('finish', stop)
  schedule(beat, delayMs)
  schedule(
    () => {
      if (state.stopped) return
      state.status = 504
      stop()
      res.destroy?.()
    },
    Math.max(delayMs + 1, maxDurationMs),
  )
  return {
    stop,
    get committed() {
      return state.committed
    },
  }
}

export function stopJsonKeepalive(res) {
  responses.get(res)?.stop()
}

// Returns true when the padded response has been completed (or aborted).
export function finishJsonKeepalive(res, status, body) {
  const state = responses.get(res)
  if (!state) return false
  state.stop()
  if (res.destroyed || res.writableEnded) return true
  if (!state.committed) {
    if (status >= 400) state.status = status
    return false
  }
  if (status < 200 || status >= 300 || body?.type === 'error' || body?.error) {
    state.status = status >= 200 && status < 300 ? 502 : status
    res.destroy()
  } else {
    const data = JSON.stringify(body)
    state.status = status
    res.end(data)
  }
  return true
}

export function abortJsonKeepalive(res, status = 500) {
  const state = responses.get(res)
  if (!state) return
  if (state.status == null || (state.status >= 200 && state.status < 300)) state.status = status
  state.stop()
  if (state.committed && !res.destroyed && !res.writableEnded) res.destroy()
}

export function jsonResponseLogStatus(res, finalState) {
  const state = responses.get(res)
  if (!state) return res.statusCode || 0
  return state.status ?? (finalState === 'cancelled' ? 499 : res.statusCode || 0)
}
