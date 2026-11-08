import { describe, expect, it } from 'vitest'
import { concurrencyLabel, parseConcurrency } from './user-concurrency'

describe('user concurrency', () => {
  it('accepts integers within 0–128 (0 = no cap)', () => {
    expect(parseConcurrency('0')).toBe(0)
    expect(parseConcurrency('1')).toBe(1)
    expect(parseConcurrency(' 20 ')).toBe(20)
    expect(parseConcurrency('128')).toBe(128)
  })

  it('rejects empty, fractional and out-of-range input', () => {
    for (const raw of ['', ' ', '-3', '129', '2.5', 'abc']) {
      expect(parseConcurrency(raw)).toBeNull()
    }
  })

  it('honors explicit admin limits and labels zero as unlimited', () => {
    expect(concurrencyLabel({ role: 'user', concurrency: 8 })).toBe('8')
    expect(concurrencyLabel({ role: 'super', concurrency: 5 })).toBe('5')
    expect(concurrencyLabel({ role: 'admin', concurrency: 5 })).toBe('5')
    expect(concurrencyLabel({ role: 'user', concurrency: 0 })).toBe('不限')
  })
})
