import test from 'node:test'
import assert from 'node:assert/strict'
import { subscriptionAvailability } from '../../src/lib/admin/panel-subscriptions.mjs'
const active = {
  status: 'active',
  plan_status: 'active',
  daily_limit_usd: 30,
  weekly_limit_usd: 100,
  daily_used: 5,
  weekly_used: 20,
}
test('user readiness gives actionable status without leaking slot identity', () => {
  const slot = {
    id: 'secret-slot',
    email: 'secret@example.test',
    has_token: true,
    schedulable: true,
    status: 'running',
  }
  assert.deepEqual(subscriptionAvailability(active, [slot]), {
    code: 'configured',
    message: '已配置调用条件；实际可用性以上游响应为准',
  })
  assert.equal(subscriptionAvailability(active, [{ ...slot, has_token: false }]).code, 'login_required')
  assert.equal(subscriptionAvailability(active, [{ ...slot, schedulable: false }]).code, 'unavailable')
  assert.equal(subscriptionAvailability(active, []).code, 'no_slots')
  assert.equal(subscriptionAvailability({ ...active, status: 'expired' }, [slot]).code, 'expired')
  assert.equal(subscriptionAvailability({ ...active, status: 'suspended' }, [slot]).code, 'suspended')
  assert.equal(subscriptionAvailability({ ...active, plan_status: 'disabled' }, [slot]).code, 'plan_disabled')
  assert.equal(subscriptionAvailability(active, [slot], 25).code, 'quota_exhausted')
  assert.equal(subscriptionAvailability({ ...active, weekly_used: 100 }, [slot]).code, 'quota_exhausted')
})
