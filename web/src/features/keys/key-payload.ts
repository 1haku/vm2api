export type KeyLimitsDraft = {
  name: string
  category: 'oauth' | 'api'
  max_concurrency: number
  quota_requests: number
  quota_usd: number
  rpm: number
  expires_in_days: number
  group_id?: number
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label}必须是非负数`)
  return value
}

export function keyLimitsPayload(
  draft: KeyLimitsDraft,
  mode: 'create' | 'edit'
): Record<string, unknown> {
  const requests = nonNegative(draft.quota_requests, '请求额度')
  if (!Number.isInteger(requests)) throw new Error('请求额度必须是整数')

  const body: Record<string, unknown> = {
    ...(draft.group_id ? { group_id: draft.group_id } : {}),
    category: draft.category,
    max_concurrency: nonNegative(draft.max_concurrency, '并发'),
    quota_requests: requests,
    quota_usd: nonNegative(draft.quota_usd, 'USD 额度'),
    rpm: nonNegative(draft.rpm, 'RPM'),
  }
  if (mode === 'create') {
    body.name = draft.name.trim()
    const days = nonNegative(draft.expires_in_days, '有效期')
    if (days > 0) body.expires_in_days = days
  }
  return body
}
