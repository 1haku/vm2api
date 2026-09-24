import { describe, expect, it } from 'vitest'
import { latestProbe, probeOutcome, probeSourceLabel } from './probe-status'

describe('probe card uses persisted checks without claiming a fresh upstream probe', () => {
  it('shows a passive check when the authoritative usage probe is absent', () => {
    const check = {
      at: '2026-09-24T01:00:00Z',
      ok: true,
      source: 'messages-headers',
    }
    expect(latestProbe(check, null).at).toBe(check.at)
    expect(probeSourceLabel(check.source)).toBe('请求响应头（缓存）')
    expect(probeOutcome(check)).toBe('已读取缓存')
  })
  it('uses a newer official probe and retains legacy fallback', () => {
    const older = { at: '2026-09-23T01:00:00Z', ok: true }
    const newer = { at: '2026-09-24T01:00:00Z', ok: true }
    expect(latestProbe(older, newer)).toBe(newer)
    expect(latestProbe(null, newer)).toBe(newer)
    expect(latestProbe()).toEqual({})
  })
  it('shows unavailable and failure responses rather than generic success', () => {
    expect(probeOutcome({ ok: false, error: '暂无请求响应头用量' })).toBe(
      '暂无请求响应头用量'
    )
    expect(probeOutcome({ ok: false })).toBe('探测失败')
    expect(probeOutcome({ ok: true })).toBe('探测成功')
  })
})
