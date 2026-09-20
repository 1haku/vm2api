import test from 'node:test'
import assert from 'node:assert/strict'
import { interpretOfficialUsage, normUsagePercent, normLegacyMixed } from '../../src/lib/oauth/usage-interpret.mjs'

test('official /usage 1 is 1% used, not 100%', () => {
  assert.equal(normUsagePercent(1), 0.01)
  assert.equal(normLegacyMixed(1), 1)
  const official = interpretOfficialUsage({
    five_hour: { utilization: 1, status: 'rejected', resets_at: '2026-08-24T11:40:00Z' },
  })
  assert.equal(official.five_hour.used_pct, 1)
  assert.equal(official.five_hour.remain_pct, 99)
  assert.equal(official.five_hour.utilization, 0.01)
})

test('official /usage reset aliases are kept', () => {
  const official = interpretOfficialUsage({
    five_hour: { utilization: 12, reset: '2026-08-24T11:40:00Z' },
    seven_day: { utilization: 34, reset_at: '2026-08-27T00:00:00Z' },
  })
  assert.equal(official.five_hour.resets_at, '2026-08-24T11:40:00Z')
  assert.equal(official.five_hour.remain_pct, 88)
  assert.equal(official.seven_day.resets_at, '2026-08-27T00:00:00Z')
})

test('official /usage 100 is full', () => {
  const official = interpretOfficialUsage({
    five_hour: { utilization: 100, status: 'rejected' },
  })
  assert.equal(official.five_hour.used_pct, 100)
  assert.equal(official.five_hour.utilization, 1)
})
