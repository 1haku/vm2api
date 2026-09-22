import type { StatsBucket } from '@/types/panel-overview'

export type StatsRange = 'today' | '7days' | '30days' | 'thisMonth'
export type StatsBucketSize = 'hour' | 'day'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export function statsRangeQuery(
  range: StatsRange,
  now = new Date()
): { since: string; bucket: StatsBucketSize } {
  if (range === 'today') {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return { since: start.toISOString(), bucket: 'hour' }
  }
  if (range === 'thisMonth') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    return { since: start.toISOString(), bucket: 'day' }
  }
  const days = range === '7days' ? 7 : 30
  const t = now.getTime() - days * DAY_MS
  return { since: new Date(t - (t % MINUTE_MS)).toISOString(), bucket: 'day' }
}

export type StatsPoint = {
  key: string
  label: string
  requests: number
  errors: number
  cost: number
}

function hourKey(t: Date): string {
  return `${t.toISOString().slice(0, 13)}:00`
}

/** 把稀疏桶补成连续轴。小时 key 与后端 strftime UTC 小时一致，标签用本地钟点。 */
export function fillStatsSeries(
  buckets: StatsBucket[] | undefined,
  sinceIso: string,
  bucket: StatsBucketSize,
  now = new Date()
): StatsPoint[] {
  const map = new Map((buckets ?? []).map((row) => [row.bucket, row]))
  const since = new Date(sinceIso)
  if (!Number.isFinite(since.getTime())) return []
  const points: StatsPoint[] = []

  if (bucket === 'hour') {
    const start = Math.floor(since.getTime() / HOUR_MS) * HOUR_MS
    const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS
    for (let t = start; t <= end; t += HOUR_MS) {
      const at = new Date(t)
      const key = hourKey(at)
      const row = map.get(key)
      points.push({
        key,
        label: `${String(at.getHours()).padStart(2, '0')}:00`,
        requests: Number(row?.requests || 0),
        errors: Number(row?.errors || 0),
        cost: Number(row?.total_cost || 0),
      })
    }
    return points
  }

  const start = Date.UTC(
    since.getUTCFullYear(),
    since.getUTCMonth(),
    since.getUTCDate()
  )
  const end = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  )
  for (let t = start; t <= end; t += DAY_MS) {
    const at = new Date(t)
    const key = at.toISOString().slice(0, 10)
    const row = map.get(key)
    points.push({
      key,
      label: `${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`,
      requests: Number(row?.requests || 0),
      errors: Number(row?.errors || 0),
      cost: Number(row?.total_cost || 0),
    })
  }
  return points
}
