import crypto from 'node:crypto'
import { withTransaction } from '../database.mjs'

export function requestLimit(value, name, max = 1000000) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max)
    throw Object.assign(new Error(`${name}须为 0–${max} 的整数（0 表示不限）`), {
      code: 'invalid_request_limit',
      status: 400,
    })
  return value
}

export class RequestLimitsRepo {
  constructor(db) {
    this.db = db
  }

  userLimits(user) {
    if (!user) return { concurrency: 0, rpm_limit: 0 }
    return (
      this.db.prepare('SELECT concurrency,rpm_limit FROM custom_user_request_limits WHERE user_id=?').get(user.id) || {
        concurrency: user.role === 'admin' ? 0 : Number(user.concurrency ?? 5),
        rpm_limit: 0,
      }
    )
  }

  saveUser(user, patch) {
    const current = this.userLimits(user)
    const concurrency = Object.hasOwn(patch, 'concurrency')
      ? requestLimit(patch.concurrency, '用户总并发', 128)
      : current.concurrency
    const rpm = Object.hasOwn(patch, 'rpm_limit') ? requestLimit(patch.rpm_limit, '用户总 RPM') : current.rpm_limit
    this.db
      .prepare(
        'INSERT INTO custom_user_request_limits(user_id,concurrency,rpm_limit) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET concurrency=excluded.concurrency,rpm_limit=excluded.rpm_limit',
      )
      .run(user.id, concurrency, rpm)
    return { concurrency, rpm_limit: rpm }
  }

  consume(key, now = Date.now(), requestId = crypto.randomUUID()) {
    return withTransaction(this.db, () => {
      const user = key.user_id ? this.db.prepare('SELECT * FROM users WHERE id=?').get(key.user_id) : null
      const limits = this.userLimits(user)
      const plan = this.db
        .prepare('SELECT group_rpm_limit,user_rpm_limit FROM custom_subscription_plans WHERE group_id=?')
        .get(key.group_id ?? 1)
      this.db.prepare('DELETE FROM custom_request_rpm_events WHERE started_at<=?').run(now - 60000)
      const checks = [
        [user && limits.rpm_limit, 'user_id=?', [key.user_id], 'user_rpm_limit', '用户总 RPM'],
        [plan?.group_rpm_limit, 'group_id=?', [key.group_id], 'group_rpm_limit', '订阅分组总 RPM'],
        [
          user && plan?.user_rpm_limit,
          'user_id=? AND group_id=?',
          [key.user_id, key.group_id],
          'subscription_user_rpm_limit',
          '订阅内每人 RPM',
        ],
      ]
      for (const [limit, where, args, code, label] of checks) {
        if (!(limit > 0)) continue
        const usage = this.db
          .prepare(`SELECT COUNT(*) AS count,MIN(started_at) AS first FROM custom_request_rpm_events WHERE ${where}`)
          .get(...args)
        if (usage.count >= limit) {
          const resetStart =
            usage.count === limit
              ? usage.first
              : this.db
                  .prepare(
                    `SELECT started_at FROM custom_request_rpm_events WHERE ${where} ORDER BY started_at LIMIT 1 OFFSET ?`,
                  )
                  .get(...args, usage.count - limit).started_at
          return {
            ok: false,
            status: 429,
            code,
            message: `${label} 已达上限（${limit}/分钟）`,
            retry_after: Math.max(1, Math.ceil((resetStart + 60000 - now) / 1000)),
            detail: { limit, used: usage.count },
          }
        }
      }
      this.db
        .prepare('INSERT INTO custom_request_rpm_events(request_id,user_id,group_id,started_at) VALUES(?,?,?,?)')
        .run(requestId, key.user_id || null, key.group_id ?? 1, now)
      return { ok: true }
    })
  }
}
