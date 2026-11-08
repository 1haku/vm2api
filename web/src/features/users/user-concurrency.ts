import type { PanelUser } from '@/types/panel-users'

// Mirrors assertConcurrency() in src/lib/admin/panel-users.mjs; new users default to 5, 0 = no cap.
export const CONCURRENCY_MIN = 0
export const CONCURRENCY_MAX = 128
export const CONCURRENCY_DEFAULT = 5

/** 输入框文本 → 并发上限；空、小数或越界返回 null。 */
export function parseConcurrency(raw: string): number | null {
  if (!raw.trim()) return null
  const n = Number(raw)
  if (!Number.isInteger(n)) return null
  return n >= CONCURRENCY_MIN && n <= CONCURRENCY_MAX ? n : null
}

/** Explicit limits apply to every role; only 0 means unlimited. */
export function concurrencyLabel(
  user: Pick<PanelUser, 'role' | 'concurrency'>
): string {
  if (!user.concurrency) return '不限'
  return String(user.concurrency)
}
