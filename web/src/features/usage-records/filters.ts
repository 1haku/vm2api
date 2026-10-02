export type UsageSearch = {
  from?: string
  until?: string
  range?: string
  api_key_id?: string
  group_id?: string
  user_id?: string
  vm_id?: string
  model?: string
  status?: string
  page?: string
}
export function parseUsageSearch(raw: Record<string, unknown>): UsageSearch {
  const result: UsageSearch = {}
  for (const field of [
    'api_key_id',
    'group_id',
    'user_id',
    'vm_id',
    'model',
  ] as const) {
    if (typeof raw[field] === 'string' && raw[field].length <= 200)
      result[field] = raw[field]
  }
  for (const field of ['from', 'until'] as const) {
    const value = String(raw[field] || '')
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
    )
      result[field] = value
  }
  if (['today', '7d', '30d', 'custom'].includes(String(raw.range)))
    result.range = String(raw.range)
  if (['success', 'error'].includes(String(raw.status)))
    result.status = String(raw.status)
  const page = Number(raw.page)
  if (Number.isInteger(page) && page > 0 && page <= 100000)
    result.page = String(page)
  return result
}
export function localDate(daysAgo = 0, now = new Date()) {
  const date = new Date(now)
  date.setDate(date.getDate() - daysAgo)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 10)
}
export function usageDates(search: UsageSearch, now = new Date()) {
  const range = search.range || (search.from || search.until ? 'custom' : '7d')
  const from =
    range === 'custom'
      ? search.from || localDate(6, now)
      : localDate(range === 'today' ? 0 : range === '30d' ? 29 : 6, now)
  const until =
    range === 'custom' ? search.until || localDate(0, now) : localDate(0, now)
  return { range, from, until, valid: from <= until }
}
export function usageMoney(value: number) {
  if (!Number.isFinite(value)) return '—'
  if (value > 0 && value < 0.000001) return '<$0.000001'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2,
  }).format(value)
}
export type KeyUsage = {
  api_key_id: string | null
  key_name: string | null
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  actual_cost: number
  success: number
  last_used_at: string | null
}
export const usageTokens = (row?: Partial<KeyUsage>) =>
  (row?.input_tokens || 0) +
  (row?.output_tokens || 0) +
  (row?.cache_read_tokens || 0) +
  (row?.cache_creation_tokens || 0)
