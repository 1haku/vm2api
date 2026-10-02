import crypto from 'node:crypto'
import { getDb, withTransaction } from '../database.mjs'
import { calculateCost, shanghaiDayStartIso } from '../../admin/pricing.mjs'

const DAY = 86400000
const iso = (n = Date.now()) => new Date(n).toISOString()
export function subscriptionError(message, status = 400, code = 'subscription_invalid') {
  return Object.assign(new Error(message), { status, code })
}
function number(value, fallback, min = 0, max = 1000000) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n) || n < min || n > max) throw subscriptionError('数值超出允许范围')
  return n
}

export class SubscriptionsRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  event(action, { id = null, group_id = null, actor = null, detail = {} } = {}) {
    this.db
      .prepare(
        'INSERT INTO custom_subscription_events(subscription_id,group_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, group_id, actor, action, JSON.stringify(detail), iso())
  }

  group(id) {
    return this.db
      .prepare(
        'SELECT g.*,p.group_id IS NOT NULL AS subscription_enabled,p.daily_limit_usd,p.weekly_limit_usd,p.default_validity_days,p.subscription_concurrency FROM groups g LEFT JOIN custom_subscription_plans p ON p.group_id=g.id WHERE g.id=?',
      )
      .get(id)
  }

  plans() {
    return this.db
      .prepare(
        'SELECT g.*,1 AS subscription_enabled,p.daily_limit_usd,p.weekly_limit_usd,p.default_validity_days,p.subscription_concurrency FROM groups g JOIN custom_subscription_plans p ON p.group_id=g.id WHERE g.deleted_at IS NULL ORDER BY g.id DESC',
      )
      .all()
      .map((g) => ({
        ...g,
        vm_ids: this.db
          .prepare('SELECT vm_id FROM custom_subscription_slots WHERE group_id=? ORDER BY vm_id')
          .all(g.id)
          .map((r) => r.vm_id),
        members: this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM custom_user_subscriptions WHERE group_id=? AND status='active' AND expires_at>?",
          )
          .get(g.id, iso()).n,
      }))
  }

  savePlan(input, actor, id = null) {
    const old = id ? this.group(id) : null
    if (id && (!old?.subscription_enabled || old.deleted_at)) throw subscriptionError('订阅方案不存在', 404)
    const name = String(input.name ?? old?.name ?? '').trim()
    if (!name || name.length > 80) throw subscriptionError('方案名称须为 1–80 个字符')
    const platform = input.platform ?? old?.platform ?? 'claude'
    if (!['claude', 'openai'].includes(platform)) throw subscriptionError('不支持的平台')
    const status = input.status ?? old?.status ?? 'active'
    if (!['active', 'disabled'].includes(status)) throw subscriptionError('无效的方案状态')
    const values = [
      name,
      String(input.description ?? old?.description ?? '').slice(0, 1000),
      platform,
      status,
      number(input.daily_limit_usd, old?.daily_limit_usd ?? 0),
      number(input.weekly_limit_usd, old?.weekly_limit_usd ?? 0),
      number(input.default_validity_days, old?.default_validity_days ?? 30, 1, 3650),
      number(input.subscription_concurrency, old?.subscription_concurrency ?? 2, 1, 100),
      number(input.rate_multiplier, old?.rate_multiplier ?? 1, 0, 100),
    ]
    const slots = input.vm_ids ?? (id ? this.plans().find((g) => g.id === id)?.vm_ids : [])
    if (
      !Array.isArray(slots) ||
      (status === 'active' && slots.length < 1) ||
      slots.length > 100 ||
      slots.some((s) => typeof s !== 'string')
    )
      throw subscriptionError('启用的方案至少需要一个槽位')
    if (!Number.isInteger(values[6]) || !Number.isInteger(values[7]))
      throw subscriptionError('有效天数和并发数须为整数')
    for (const vmId of slots) {
      const vm = this.db.prepare('SELECT * FROM vms WHERE id=?').get(vmId)
      if (!vm) throw subscriptionError(`槽位不存在：${vmId}`)
      if (vm.owner_user_id) throw subscriptionError(`槽位 ${vmId} 已分配给个人，请先收回`)
      const binding = this.db.prepare('SELECT group_id FROM custom_subscription_slots WHERE vm_id=?').get(vmId)
      if (binding && binding.group_id !== id) throw subscriptionError(`槽位 ${vmId} 已绑定其他订阅方案`)
    }
    return withTransaction(this.db, () => {
      let groupId = id
      if (groupId) {
        this.db
          .prepare(
            'UPDATE groups SET name=?,description=?,platform=?,status=?,rate_multiplier=?,updated_at=? WHERE id=?',
          )
          .run(...values.slice(0, 4), values[8], iso(), groupId)
      } else {
        groupId = Number(
          this.db
            .prepare(
              'INSERT INTO groups(name,description,platform,status,rate_multiplier,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
            )
            .run(...values.slice(0, 4), values[8], iso(), iso()).lastInsertRowid,
        )
      }
      this.db
        .prepare(
          'INSERT INTO custom_subscription_plans(group_id,daily_limit_usd,weekly_limit_usd,default_validity_days,subscription_concurrency) VALUES(?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET daily_limit_usd=excluded.daily_limit_usd,weekly_limit_usd=excluded.weekly_limit_usd,default_validity_days=excluded.default_validity_days,subscription_concurrency=excluded.subscription_concurrency',
        )
        .run(groupId, ...values.slice(4, 8))
      this.db.prepare('DELETE FROM custom_subscription_slots WHERE group_id=?').run(groupId)
      for (const vmId of new Set(slots))
        this.db.prepare('INSERT INTO custom_subscription_slots(group_id,vm_id) VALUES(?,?)').run(groupId, vmId)
      this.event(id ? 'plan_updated' : 'plan_created', { group_id: groupId, actor, detail: { name, vm_ids: slots } })
      return this.plans().find((g) => g.id === groupId)
    })
  }

  assign(input, actor) {
    const group = this.plans().find((g) => g.id === Number(input.group_id))
    if (!group || group.status !== 'active') throw subscriptionError('请选择启用的订阅方案')
    if (!Array.isArray(input.user_ids)) throw subscriptionError('请选择 1–100 名用户')
    const users = [...new Set(input.user_ids)]
    if (!users.length || users.length > 100 || users.some((u) => typeof u !== 'string'))
      throw subscriptionError('请选择 1–100 名用户')
    const days = number(input.validity_days, group.default_validity_days, 1, 3650)
    if (!Number.isInteger(days)) throw subscriptionError('有效天数须为整数')
    for (const user of users) {
      if (!this.db.prepare("SELECT id FROM users WHERE id=? AND deleted_at IS NULL AND status='active'").get(user))
        throw subscriptionError('所选用户不存在或已停用')
    }
    return withTransaction(this.db, () =>
      users.map((user) => {
        const old = this.db
          .prepare('SELECT * FROM custom_user_subscriptions WHERE user_id=? AND group_id=?')
          .get(user, group.id)
        const now = iso()
        const id = old?.id || `sub_${crypto.randomUUID()}`
        if (old) {
          this.db
            .prepare("UPDATE custom_user_subscriptions SET status='active',expires_at=?,updated_at=? WHERE id=?")
            .run(iso(Math.max(Date.now(), Date.parse(old.expires_at)) + days * DAY), now, id)
        } else {
          this.db
            .prepare(
              'INSERT INTO custom_user_subscriptions(id,user_id,group_id,starts_at,expires_at,reset_at,assigned_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
            )
            .run(id, user, group.id, now, iso(Date.now() + days * DAY), now, actor, now, now)
        }
        this.event(old ? 'renewed' : 'assigned', { id, group_id: group.id, actor, detail: { user_id: user, days } })
        return id
      }),
    )
  }

  batch(input, actor) {
    const { ids, action } = input
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length
    )
      throw subscriptionError('请选择 1–100 个不同的订阅')
    if (!['renew', 'suspend', 'resume'].includes(action)) throw subscriptionError('无效的批量操作')
    const days = action === 'renew' ? number(input.days, 30, 1, 3650) : null
    if (days !== null && !Number.isInteger(days)) throw subscriptionError('续期天数须为整数')
    return withTransaction(this.db, () => {
      for (const id of ids) {
        const sub = this.db.prepare('SELECT * FROM custom_user_subscriptions WHERE id=?').get(id)
        if (!sub) throw subscriptionError('所选订阅不存在，请刷新后重试', 404)
        if (action !== 'suspend') {
          const plan = this.group(sub.group_id)
          const user = this.db
            .prepare("SELECT id FROM users WHERE id=? AND status='active' AND deleted_at IS NULL")
            .get(sub.user_id)
          if (!plan || plan.deleted_at || plan.status !== 'active' || !user)
            throw subscriptionError('所选订阅包含停用的方案或用户')
          if (sub.status === 'revoked') throw subscriptionError('已撤销的订阅需重新分配')
          if (action === 'resume' && sub.expires_at <= iso()) throw subscriptionError('已到期的订阅请先续期')
        }
      }
      for (const id of ids)
        this.update(
          id,
          action === 'renew' ? { action, days } : { status: action === 'suspend' ? 'suspended' : 'active' },
          actor,
        )
      this.event(`batch_${action}`, { actor, detail: { ids, days } })
      return { ids, action, count: ids.length }
    })
  }

  update(id, input, actor) {
    const sub = this.db.prepare('SELECT * FROM custom_user_subscriptions WHERE id=?').get(id)
    if (!sub) throw subscriptionError('订阅不存在', 404)
    return withTransaction(this.db, () => {
      if (input.action === 'reset') {
        this.db
          .prepare(
            'UPDATE custom_user_subscriptions SET reset_at=?,reset_ledger_rowid=(SELECT COALESCE(MAX(rowid),0) FROM custom_subscription_ledger),updated_at=? WHERE id=?',
          )
          .run(iso(), iso(), id)
      } else if (input.action === 'renew') {
        const days = number(input.days, 30, 1, 3650)
        if (!Number.isInteger(days)) throw subscriptionError('续期天数须为整数')
        this.db
          .prepare("UPDATE custom_user_subscriptions SET expires_at=?,status='active',updated_at=? WHERE id=?")
          .run(iso(Math.max(Date.now(), Date.parse(sub.expires_at)) + days * DAY), iso(), id)
      } else if (['active', 'suspended', 'revoked'].includes(input.status)) {
        this.db
          .prepare('UPDATE custom_user_subscriptions SET status=?,updated_at=? WHERE id=?')
          .run(input.status, iso(), id)
      } else throw subscriptionError('无效操作')
      this.event(input.action || input.status, { id, group_id: sub.group_id, actor })
      return this.list(null).find((s) => s.id === id)
    })
  }

  progress(sub, now = Date.now()) {
    const day = shanghaiDayStartIso(new Date(now))
    const anchor = Date.parse(sub.starts_at)
    const week = anchor + Math.max(0, Math.floor((now - anchor) / (7 * DAY))) * 7 * DAY
    const dayStart = sub.reset_at > day ? sub.reset_at : day
    const weekStart = sub.reset_at > iso(week) ? sub.reset_at : iso(week)
    const spent = (since) =>
      this.db
        .prepare(
          'SELECT COALESCE(SUM(amount),0) AS n FROM custom_subscription_ledger WHERE subscription_id=? AND created_at>=? AND rowid>?',
        )
        .get(sub.id, since, sub.reset_ledger_rowid || 0).n
    return {
      daily_used: spent(dayStart),
      weekly_used: spent(weekStart),
      daily_reset_at: iso(Date.parse(day) + DAY),
      weekly_reset_at: iso(week + 7 * DAY),
    }
  }

  list(userId) {
    const rows = this.db
      .prepare(
        `SELECT s.*,g.name AS plan_name,g.platform,g.status AS plan_status,p.daily_limit_usd,p.weekly_limit_usd,p.subscription_concurrency,g.rate_multiplier,u.username FROM custom_user_subscriptions s JOIN groups g ON g.id=s.group_id JOIN custom_subscription_plans p ON p.group_id=g.id JOIN users u ON u.id=s.user_id ${userId ? 'WHERE s.user_id=?' : ''} ORDER BY s.created_at DESC`,
      )
      .all(...(userId ? [userId] : []))
    return rows.map((s) => ({
      ...s,
      ...this.progress(s),
      status: s.status === 'active' && s.expires_at <= iso() ? 'expired' : s.status,
    }))
  }

  entitlement(key) {
    const group = this.group(key?.group_id ?? 1)
    if (!group?.subscription_enabled) return null
    if (group.status !== 'active' || group.deleted_at)
      throw subscriptionError('订阅方案已停用', 403, 'subscription_disabled')
    const sub = this.db
      .prepare('SELECT * FROM custom_user_subscriptions WHERE user_id=? AND group_id=?')
      .get(key.user_id || '', group.id)
    if (!sub || sub.status !== 'active' || sub.expires_at <= iso() || sub.starts_at > iso())
      throw subscriptionError('订阅不存在、已暂停或已到期', 403, 'subscription_inactive')
    const vmIds = this.db
      .prepare('SELECT vm_id FROM custom_subscription_slots WHERE group_id=?')
      .all(group.id)
      .map((r) => r.vm_id)
    if (!vmIds.length) throw subscriptionError('订阅未绑定可用槽位', 503, 'subscription_no_slots')
    return { ...sub, group, vmIds }
  }

  assertKey(userId, groupId, category, role) {
    const group = this.group(Number(groupId || 1))
    if (!group || group.deleted_at) throw subscriptionError('分组不存在')
    if (group.subscription_enabled) {
      if (category === 'api') throw subscriptionError('槽位订阅仅支持槽位密钥')
      this.entitlement({ user_id: userId, group_id: group.id })
    } else if (role === 'user') {
      const owned = this.db.prepare('SELECT id FROM vms WHERE owner_user_id=? LIMIT 1').get(userId)
      if (!owned) throw subscriptionError('请先由管理员分配订阅，并选择订阅方案', 403)
      if (category === 'api') throw subscriptionError('普通用户不能访问公共 API 池', 403)
    }
  }

  reserve(key, requestId, body) {
    return withTransaction(this.db, () => {
      const sub = this.entitlement(key)
      if (!sub) return null
      const pending = this.db
        .prepare(
          'SELECT COUNT(*) AS n,COALESCE(SUM(amount),0) AS cost FROM custom_subscription_reservations WHERE subscription_id=?',
        )
        .get(sub.id)
      if (pending.n >= sub.group.subscription_concurrency)
        throw subscriptionError('订阅并发已满，请稍后重试', 429, 'subscription_concurrency')
      const progress = this.progress(sub)
      const bytes = Buffer.byteLength(JSON.stringify(body || {}))
      const requestedOutput = Number(body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens ?? 16384)
      if (!Number.isFinite(requestedOutput) || requestedOutput < 1) throw subscriptionError('输出 Token 上限无效')
      const estimate = calculateCost(
        {
          input_tokens: bytes + 8192,
          output_tokens: requestedOutput,
          requested_speed: body.speed,
          service_tier: body.service_tier,
        },
        body.model,
      )
      const limited = sub.group.daily_limit_usd > 0 || sub.group.weekly_limit_usd > 0
      if (limited && !estimate?.known)
        throw subscriptionError('此模型尚未配置计价，无法使用限额订阅', 403, 'subscription_unpriced_model')
      const amount = (estimate?.total_cost || 0) * sub.group.rate_multiplier
      for (const [limit, used] of [
        [sub.group.daily_limit_usd, progress.daily_used],
        [sub.group.weekly_limit_usd, progress.weekly_used],
      ]) {
        if (limit > 0 && used + pending.cost + amount > limit)
          throw subscriptionError(
            '订阅剩余额度不足（含进行中请求预留），请降低输出上限或等待重置',
            429,
            'subscription_quota',
          )
      }
      this.db
        .prepare(
          'INSERT INTO custom_subscription_reservations(request_id,subscription_id,amount,created_at) VALUES(?,?,?,?)',
        )
        .run(requestId, sub.id, amount, iso())
      return { ...sub, reserved: amount }
    })
  }

  settle(requestId, subscriptionId, amount) {
    if (!subscriptionId) return
    this.db
      .prepare(
        'INSERT OR IGNORE INTO custom_subscription_ledger(request_id,subscription_id,amount,created_at) VALUES(?,?,?,?)',
      )
      .run(requestId, subscriptionId, Math.max(0, Number(amount) || 0), iso())
    this.db.prepare('DELETE FROM custom_subscription_reservations WHERE request_id=?').run(requestId)
  }

  recoverReservations() {
    return withTransaction(this.db, () => {
      const pending = this.db.prepare('SELECT * FROM custom_subscription_reservations').all()
      for (const row of pending) {
        this.db.prepare('DELETE FROM custom_subscription_reservations WHERE request_id=?').run(row.request_id)
        this.event('interrupted_reservation_released', {
          id: row.subscription_id,
          detail: {
            request_id: row.request_id,
            reserved: row.amount,
            reason: '进程中断，实际用量未知，释放预留并记录待核查事件',
          },
        })
      }
      return pending.length
    })
  }

  responseOwner(responseId, key) {
    return this.db
      .prepare('SELECT vm_id FROM custom_response_owners WHERE response_id=? AND user_id=? AND group_id=?')
      .get(responseId, key.user_id, key.group_id ?? 1)
  }

  rememberResponse(responseId, key, vmId) {
    if (!responseId || !key?.user_id) return
    this.db
      .prepare(
        'INSERT OR IGNORE INTO custom_response_owners(response_id,user_id,group_id,vm_id,created_at) VALUES(?,?,?,?,?)',
      )
      .run(responseId, key.user_id, key.group_id ?? 1, vmId, iso())
  }
}
