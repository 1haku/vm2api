import { SubscriptionsRepo, subscriptionError } from '../db/repos/subscriptions-repo.mjs'
import { getDb, withTransaction } from '../db/database.mjs'
import { panelIdentity } from './panel-acl.mjs'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { subscriptionOverview } from './subscription-overview.mjs'

// This is a configuration readiness summary, not an upstream health probe.
export function subscriptionAvailability(sub, slots = [], pending = 0) {
  if (sub.plan_status !== 'active') return { code: 'plan_disabled', message: '方案已停用，请联系管理员' }
  if (sub.status !== 'active')
    return {
      code: sub.status,
      message:
        {
          expired: '订阅已到期，请联系管理员续期',
          suspended: '订阅已暂停，请联系管理员',
          revoked: '订阅已撤销，请联系管理员',
        }[sub.status] || '订阅尚未生效',
    }
  if (
    (sub.daily_limit_usd > 0 && sub.daily_used + pending >= sub.daily_limit_usd) ||
    (sub.weekly_limit_usd > 0 && sub.weekly_used + pending >= sub.weekly_limit_usd)
  )
    return { code: 'quota_exhausted', message: '个人额度已用尽或被进行中请求预留，请等待重置' }
  if (!slots.length) return { code: 'no_slots', message: '尚未配置可用账号，请联系管理员' }
  if (!slots.some((v) => v.has_token))
    return { code: 'login_required', message: '上游账号尚未登录，请联系管理员完成登录' }
  if (!slots.some((v) => v.has_token && v.schedulable !== false && v.status === 'running'))
    return { code: 'unavailable', message: '上游账号暂未开放调用，请联系管理员检查状态' }
  return { code: 'configured', message: '已配置调用条件；实际可用性以上游响应为准' }
}

export function usageRecords(db, params, userId, admin = false) {
  const where = []
  const values = []
  const add = (sql, value) => {
    where.push(sql)
    values.push(value)
  }
  if (!admin) add('l.user_id=?', userId || '__no_user__')
  else if (params.get('user_id')) add('l.user_id=?', params.get('user_id'))
  for (const [key, column] of [
    ['group_id', 'group_id'],
    ['api_key_id', 'api_key_id'],
    ['model', 'model'],
  ]) {
    if (params.get(key)) add(`l.${column}=?`, params.get(key))
  }
  if (admin && params.get('vm_id')) add('l.vm_id=?', params.get('vm_id'))
  const from = params.get('from') || new Date(Date.now() - 7 * 86400000).toISOString()
  const until = params.get('until') || new Date().toISOString()
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(until)) || Date.parse(from) > Date.parse(until))
    throw subscriptionError('时间范围无效')
  add('l.created_at>=?', new Date(from).toISOString())
  add('l.created_at<=?', new Date(until).toISOString())
  if (params.get('status') === 'success') where.push('l.status BETWEEN 200 AND 299')
  if (params.get('status') === 'error') where.push('(l.status NOT BETWEEN 200 AND 299 OR l.status IS NULL)')
  const cond = 'WHERE ' + where.join(' AND ')
  const page = Math.max(1, Math.min(100000, parseInt(params.get('page')) || 1))
  const size = Math.max(1, Math.min(100, parseInt(params.get('page_size')) || 25))
  const select = `COUNT(*) AS requests,COALESCE(SUM(l.input_tokens),0) AS input_tokens,COALESCE(SUM(l.output_tokens),0) AS output_tokens,COALESCE(SUM(l.cache_read_tokens),0) AS cache_read_tokens,COALESCE(SUM(l.cache_creation_tokens),0) AS cache_creation_tokens,COALESCE(SUM(l.actual_cost),0) AS actual_cost,COALESCE(SUM(l.total_cost),0) AS reference_cost,COALESCE(AVG(l.duration_ms),0) AS duration_ms,COALESCE(SUM(CASE WHEN l.status BETWEEN 200 AND 299 THEN 1 ELSE 0 END),0) AS success`
  const totals = db.prepare(`SELECT ${select} FROM usage_logs l ${cond}`).get(...values)
  const items = db
    .prepare(
      `SELECT l.request_id,l.created_at,l.model,l.status,l.input_tokens,l.output_tokens,l.cache_read_tokens,l.cache_creation_tokens,l.actual_cost,l.total_cost,l.duration_ms,l.first_token_ms,l.group_id,l.subscription_id,l.api_key_id,${admin ? 'l.user_id,l.vm_id,u.username,' : ''}g.name AS plan_name,k.name AS key_name FROM usage_logs l LEFT JOIN groups g ON g.id=l.group_id LEFT JOIN api_keys k ON k.id=l.api_key_id ${admin ? '' : 'AND k.user_id=l.user_id'} LEFT JOIN users u ON u.id=l.user_id ${cond} ORDER BY l.created_at DESC,l.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...values, size, (page - 1) * size)
  const trend = db
    .prepare(
      `SELECT strftime('%Y-%m-%d',l.created_at,'+8 hours') AS day,${select} FROM usage_logs l ${cond} GROUP BY day ORDER BY day`,
    )
    .all(...values)
  const models = db
    .prepare(`SELECT l.model,${select} FROM usage_logs l ${cond} GROUP BY l.model ORDER BY requests DESC LIMIT 20`)
    .all(...values)
  const keys = db
    .prepare(
      `SELECT l.api_key_id,MAX(k.name) AS key_name,MAX(l.created_at) AS last_used_at,${select} FROM usage_logs l LEFT JOIN api_keys k ON k.id=l.api_key_id ${admin ? '' : 'AND k.user_id=l.user_id'} ${cond} GROUP BY l.api_key_id ORDER BY actual_cost DESC,requests DESC,l.api_key_id`,
    )
    .all(...values)
  return {
    items,
    totals,
    trend,
    models,
    keys,
    page,
    page_size: size,
    total: totals.requests,
    timezone: 'Asia/Shanghai',
  }
}

export async function handleSubscriptionPanel(req, res, { path, json, readBody, projectRoot, slotInflight = () => 0 }) {
  if (!/^\/api\/panel\/(subscription-plans|subscriptions|usage-records)(\/|$)/.test(path)) return false
  const ident = panelIdentity(req)
  const admin = ident.role === 'admin'
  const db = getDb()
  const repo = new SubscriptionsRepo(db)
  try {
    let result
    if (path === '/api/panel/usage-records' && req.method === 'GET') {
      result = usageRecords(db, new URL(req.url, 'http://localhost').searchParams, req.panelUserId, admin)
    } else if (path === '/api/panel/subscriptions' && req.method === 'GET') {
      result = { items: repo.list(admin ? null : req.panelUserId || '__no_user__') }
      const slots = listVms(projectRoot)
      const plans = new Map(repo.plans().map((p) => [p.id, p]))
      result.items = result.items.map((s) => {
        const pending = db
          .prepare('SELECT COALESCE(SUM(amount),0) AS n FROM custom_subscription_reservations WHERE subscription_id=?')
          .get(s.id).n
        return {
          ...s,
          pending_cost: pending,
          availability: subscriptionAvailability(
            s,
            slots.filter((v) => plans.get(s.group_id)?.vm_ids.includes(v.id)),
            pending,
          ),
        }
      })
      if (!admin) result.items = result.items.map(({ assigned_by, username, ...s }) => s)
    } else if (path === '/api/panel/subscription-plans' && req.method === 'GET') {
      const own = new Set(
        repo
          .list(req.panelUserId || '__no_user__')
          .filter((s) => s.status === 'active' && s.plan_status === 'active')
          .map((s) => s.group_id),
      )
      result = {
        items: admin
          ? repo.plans()
          : repo
              .plans()
              .filter((p) => own.has(p.id))
              .map((p) => ({ id: p.id, name: p.name, platform: p.platform, description: p.description })),
      }
    } else {
      if (!admin) throw subscriptionError('仅管理员可执行此操作', 403)
      const body = req.method === 'GET' ? {} : await readBody(req, 32768)
      if (path === '/api/panel/subscriptions/admin-overview' && req.method === 'GET') {
        const days = Number(new URL(req.url, 'http://localhost').searchParams.get('days') || 1)
        const slots = listVms(projectRoot)
        result = subscriptionOverview(db, slots, days, Object.fromEntries(slots.map((s) => [s.id, slotInflight(s.id)])))
      } else if (path === '/api/panel/subscriptions/batch' && req.method === 'POST') {
        result = repo.batch(body, req.panelUserId || 'master')
      } else if (path === '/api/panel/subscriptions/provision' && req.method === 'POST') {
        const plan = body.plan
        if (!plan || !Array.isArray(plan.vm_ids)) throw subscriptionError('请选择方案槽位')
        for (const id of plan.vm_ids) {
          const vm = getVm(projectRoot, id)
          if (!vm || (isCodexVm(vm) ? 'openai' : 'claude') !== (plan.platform || 'claude'))
            throw subscriptionError('所选槽位与方案平台不匹配')
        }
        result = withTransaction(db, () => {
          const created = repo.savePlan(plan, req.panelUserId || 'master')
          const ids = repo.assign(
            { group_id: created.id, user_ids: body.user_ids, validity_days: body.validity_days },
            req.panelUserId || 'master',
          )
          return { plan: created, ids }
        })
      } else if (
        (path === '/api/panel/subscription-plans' && req.method === 'POST') ||
        (/^\/api\/panel\/subscription-plans\/\d+$/.test(path) && req.method === 'PATCH')
      ) {
        const id = req.method === 'PATCH' ? Number(path.split('/').pop()) : null
        const old = id ? repo.plans().find((p) => p.id === id) : null
        const platform = body.platform ?? old?.platform ?? 'claude'
        for (const vmId of body.vm_ids || old?.vm_ids || []) {
          const vm = getVm(projectRoot, vmId)
          if (!vm || (isCodexVm(vm) ? 'openai' : 'claude') !== platform)
            throw subscriptionError('所选槽位与方案平台不匹配')
        }
        result = repo.savePlan(body, req.panelUserId || 'master', id)
      } else if (path === '/api/panel/subscriptions' && req.method === 'POST') {
        result = { ids: repo.assign(body, req.panelUserId || 'master') }
      } else if (/^\/api\/panel\/subscriptions\/[^/]+$/.test(path) && req.method === 'PATCH') {
        result = repo.update(path.split('/').pop(), body, req.panelUserId || 'master')
      } else if (path === '/api/panel/subscriptions/events' && req.method === 'GET') {
        result = {
          items: db
            .prepare(
              'SELECT e.*,u.username AS actor_name,g.name AS plan_name FROM custom_subscription_events e LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN groups g ON g.id=e.group_id ORDER BY e.id DESC LIMIT 100',
            )
            .all(),
        }
      } else throw subscriptionError('接口不存在', 404)
    }
    json(res, 200, { ok: true, data: result })
  } catch (error) {
    json(res, error.status || 400, {
      ok: false,
      error: { code: error.code || 'subscription_error', message: error.message },
    })
  }
  return true
}
