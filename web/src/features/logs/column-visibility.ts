export const HIDEABLE_LOG_COLUMNS = [
  { id: 'account', label: '账号' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'cache', label: '缓存' },
  { id: 'cost', label: '费用' },
  { id: 'perf', label: '性能' },
  { id: 'stop', label: '结束原因' },
] as const

export type HideableLogColumn = (typeof HIDEABLE_LOG_COLUMNS)[number]['id']

const STORAGE_KEY = 'vm2api-logs-columns'

const IDS = new Set<string>(HIDEABLE_LOG_COLUMNS.map((col) => col.id))

export function isHideableLogColumn(value: string): value is HideableLogColumn {
  return IDS.has(value)
}

export function readHiddenLogColumns(): HideableLogColumn[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw.filter(
      (id): id is HideableLogColumn =>
        typeof id === 'string' && isHideableLogColumn(id)
    )
  } catch {
    return []
  }
}

export function writeHiddenLogColumns(hidden: readonly HideableLogColumn[]) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(hidden))
}

export function columnVisible(
  hidden: readonly HideableLogColumn[] | undefined,
  id: HideableLogColumn
): boolean {
  return !hidden?.includes(id)
}
