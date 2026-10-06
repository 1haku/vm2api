import { SubscriptionsRepo, subscriptionError } from '../db/repos/subscriptions-repo.mjs'
import { shanghaiDayStartIso } from './pricing.mjs'

export function subscriptionOverview(db, slots, days = 1, inflight = {}) {
  if (![1, 7, 30].includes(days)) throw subscriptionError('统计范围须为 1、7 或 30 天')
  const today = shanghaiDayStartIso(new Date())
  const from = new Date(Date.parse(today) - (days - 1) * 86400000).toISOString()
  const until = new Date().toISOString()
  const sums = `COUNT(*) AS requests,COALESCE(SUM(input_tokens+output_tokens+cache_read_tokens+cache_creation_tokens),0) AS tokens,COALESCE(SUM(actual_cost),0) AS cost,SUM(CASE WHEN status BETWEEN 200 AND 299 THEN 0 ELSE 1 END) AS errors,MAX(created_at) AS last_call`
  const users = db
    .prepare(`SELECT user_id,${sums} FROM usage_logs WHERE created_at>=? AND created_at<=? GROUP BY user_id`)
    .all(today, until)
  const loads = new Map(
    db
      .prepare(
        `SELECT vm_id,COUNT(DISTINCT user_id) AS active_users,${sums} FROM usage_logs WHERE created_at>=? AND created_at<=? GROUP BY vm_id`,
      )
      .all(from, until)
      .map((s) => [s.vm_id, s]),
  )
  const repo = new SubscriptionsRepo(db)
  const subscriptions = repo.list()
  const plans = repo.plans()
  const activeUserIds = new Set(
    db
      .prepare("SELECT id FROM users WHERE status='active' AND deleted_at IS NULL")
      .all()
      .map((u) => u.id),
  )
  return {
    users,
    subscriptions,
    timezone: 'Asia/Shanghai',
    today,
    from,
    until,
    days,
    slots: slots.map((slot) => {
      const slotPlans = plans.filter((p) => p.vm_ids.includes(slot.id))
      const planIds = new Set(slotPlans.map((p) => p.id))
      const members = subscriptions.filter(
        (s) =>
          planIds.has(s.group_id) &&
          s.status === 'active' &&
          s.plan_status === 'active' &&
          s.starts_at <= until &&
          activeUserIds.has(s.user_id),
      )
      return {
        vm_id: slot.id,
        name: slot.name || slot.id,
        status: slot.status,
        has_token: slot.has_token,
        schedulable: slot.schedulable,
        plans: slotPlans.map((p) => ({ id: p.id, name: p.name, status: p.status })),
        plan_id: slotPlans.length === 1 ? slotPlans[0].id : null,
        plan_name: slotPlans.map((p) => p.name).join('、') || null,
        subscribed_users: new Set(members.map((s) => s.user_id)).size,
        inflight: inflight[slot.id] ?? 0,
        max_concurrency: slot.max_concurrency ?? 2,
        ...(loads.get(slot.id) || { requests: 0, tokens: 0, cost: 0, errors: 0, active_users: 0, last_call: null }),
      }
    }),
  }
}
