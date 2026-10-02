import { describe, it, expect } from 'vitest'
import { parseUsageSearch, usageDates, usageMoney } from './filters'

describe('usage range and deep links', () => {
  it('retains key and valid filters without accepting invalid dates or pages', () => {
    expect(
      parseUsageSearch({
        api_key_id: 'key-a',
        from: '2026-02-30',
        until: '2026-09-20',
        page: -1,
        status: 'error',
        extra: 'ignored',
      })
    ).toEqual({ api_key_id: 'key-a', until: '2026-09-20', status: 'error' })
  })
  it('uses calendar days and honors an explicit custom range', () => {
    const now = new Date(2026, 9, 2, 12)
    expect(usageDates({ range: '7d' }, now)).toMatchObject({
      from: '2026-09-26',
      until: '2026-10-02',
      valid: true,
    })
    expect(usageDates({ range: '30d' }, now).from).toBe('2026-09-03')
    expect(
      usageDates({ from: '2026-09-01', until: '2026-09-20' }, now)
    ).toMatchObject({
      range: 'custom',
      from: '2026-09-01',
      until: '2026-09-20',
    })
    expect(
      usageDates(
        { range: 'custom', from: '2026-10-03', until: '2026-10-02' },
        now
      ).valid
    ).toBe(false)
  })
  it('does not round small nonzero consumption to zero', () => {
    expect(usageMoney(0.000042)).toBe('$0.000042')
    expect(usageMoney(0.00000001)).toBe('<$0.000001')
    expect(usageMoney(30)).toBe('$30.00')
  })
})
