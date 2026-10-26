// Persist the same user/plan scope that the in-memory seat book uses.
export function stickyTenantPrefix(req) {
  const userId = String(req?.apiKeyRecord?.user_id || '')
  const groupId = Number(req?.subscriptionAdmission?.group_id)
  if (userId && Number.isSafeInteger(groupId) && groupId > 0)
    return `sub${encodeURIComponent(JSON.stringify([userId, groupId]))}:`
  return userId ? `u${userId}:` : ''
}

export function scopedSessionFromStickyKey(key) {
  let raw = String(key || '')
  if (raw.startsWith('p:anthropic:')) raw = raw.slice('p:anthropic:'.length)
  const match = /^sub([^:]+):sess:(.+)$/.exec(raw)
  if (match) {
    try {
      const tuple = JSON.parse(decodeURIComponent(match[1]))
      if (!Array.isArray(tuple) || tuple.length !== 2) return null
      const [userId, groupId] = tuple
      if (typeof userId !== 'string' || !userId || !Number.isSafeInteger(groupId) || groupId < 1) return null
      return { sessionId: match[2], scope: { type: 'subscription', groupId, key: { user_id: userId } } }
    } catch {
      return null
    }
  }
  // Legacy user-only rows have no plan identity. Restore these only for a VM
  // actually owned by that user; never guess the plan of a shared-slot row.
  const user = /^u([^:]+):sess:(.+)$/.exec(raw)
  if (user) return { sessionId: user[2], scope: { type: 'user', userId: user[1] } }
  if (!raw.startsWith('sess:') || raw.includes(':k')) return null
  return { sessionId: raw.slice(5), scope: null }
}
