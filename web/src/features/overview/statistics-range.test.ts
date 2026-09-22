import { describe, expect, it } from 'vitest'
import { fillStatsSeries, statsRangeQuery } from './statistics-range'

const NOW = new Date('2026-09-22T06:30:00.000Z')

describe('statsRangeQuery', () => {
  it('uses hourly buckets from local midnight for today', () => {
    const query = statsRangeQuery('today', NOW)
    expect(query.bucket).toBe('hour')
    const start = new Date(query.since)
    expect(start.getHours()).toBe(0)
    expect(start.getDate()).toBe(NOW.getDate())
  })

  it('uses daily buckets for week, month window, and calendar month', () => {
    expect(statsRangeQuery('7days', NOW).bucket).toBe('day')
    expect(statsRangeQuery('30days', NOW).bucket).toBe('day')
    const month = statsRangeQuery('thisMonth', NOW)
    expect(month.bucket).toBe('day')
    const start = new Date(month.since)
    expect(start.getDate()).toBe(1)
  })
})

describe('fillStatsSeries', () => {
  it('fills missing hours with zeros and keeps utc keys', () => {
    const since = new Date(NOW)
    since.setUTCHours(4, 0, 0, 0)
    const hit = `${since.toISOString().slice(0, 13)}:00`
    const points = fillStatsSeries(
      [{ bucket: hit, requests: 3, total_cost: 1.5 }],
      since.toISOString(),
      'hour',
      NOW
    )
    expect(points.length).toBeGreaterThan(1)
    expect(points.find((point) => point.key === hit)).toMatchObject({
      requests: 3,
      cost: 1.5,
    })
    expect(points.some((point) => point.requests === 0)).toBe(true)
  })

  it('fills missing days across the range', () => {
    const since = new Date(Date.UTC(2026, 8, 20))
    const points = fillStatsSeries(
      [{ bucket: '2026-09-21', requests: 2, total_cost: 0.5 }],
      since.toISOString(),
      'day',
      NOW
    )
    expect(points.map((point) => point.key)).toEqual([
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
    ])
    expect(points[0]?.requests).toBe(0)
    expect(points[1]?.requests).toBe(2)
  })
})
