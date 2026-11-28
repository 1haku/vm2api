const WINDOW_MS = 10 * 60_000
const MAX_SESSIONS = 2048
const scopeKey = ({ apiKeyId, sessionId, model }) => JSON.stringify([apiKeyId, sessionId, model])

// Only a failed native tool handoff can arm this guard. Clients sometimes
// append messages and submit a new turn even after receiving a terminal error.
export function createNativeToolSessionGuard(findRecent, now = Date.now) {
  const paused = new Map()
  function remember(key, time) {
    paused.delete(key)
    paused.set(key, time + WINDOW_MS)
    if (paused.size > MAX_SESSIONS) paused.delete(paused.keys().next().value)
  }
  return {
    mark(scope) {
      if (scope) remember(scopeKey(scope), now())
    },
    blocks(scope) {
      if (!scope) return false
      const key = scopeKey(scope)
      const time = now()
      if (!(paused.get(key) > time)) {
        paused.delete(key)
        if (!findRecent(scope, new Date(time - WINDOW_MS).toISOString())) return false
      }
      remember(key, time)
      return true
    },
  }
}
