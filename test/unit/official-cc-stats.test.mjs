import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOfficialCcStats, inferTierFromOfficialStats } from '../../src/lib/oauth/official-cc-stats.mjs'

test('parses official /stats text for Pro + 5h/7d', () => {
  const stats = parseOfficialCcStats('Plan: Claude Pro\n5-hour limit: 12% used\n7-day limit: 34% used')
  assert.equal(stats.account_tier, 'pro')
  assert.equal(stats.five_hour.utilization, 0.12)
  assert.equal(stats.seven_day.utilization, 0.34)
})

test('parses Max and extra usage from text', () => {
  assert.equal(inferTierFromOfficialStats('Current plan: Claude Max'), 'max')
  const stats = parseOfficialCcStats('Claude Max\nExtra usage: enabled\nWeekly 8%')
  assert.equal(stats.account_tier, 'max')
  assert.equal(stats.extra_usage.is_enabled, true)
  assert.equal(stats.seven_day.utilization, 0.08)
})

test('local cost /stats without quota is not a successful ingest', () => {
  const stats = parseOfficialCcStats(
    JSON.stringify({
      type: 'result',
      is_error: false,
      result: 'Total cost:            $0.0000\nTotal duration (API):  0s',
    }),
  )
  assert.equal(stats.ok, false)
  assert.equal(stats.account_tier, null)
})

test('parses JSON envelope result text', () => {
  const stats = parseOfficialCcStats(
    JSON.stringify({
      type: 'result',
      result: 'Plan: Claude Pro\n5-hour 4%',
    }),
  )
  assert.equal(stats.account_tier, 'pro')
  assert.equal(stats.five_hour.utilization_pct, 4)
  assert.equal(stats.ok, true)
})

test('stream-json /usage reads usage_report limits including Fable', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({
      type: 'assistant',
      usage_report: {
        rate_limits: {
          limits: [
            { kind: 'session', group: 'session', percent: 12, resets_at: '2026-09-24T20:00:00Z' },
            { kind: 'weekly_all', group: 'weekly', percent: 34, resets_at: '2026-09-30T00:00:00Z' },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 21,
              resets_at: '2026-09-30T00:00:00Z',
              scope: { model: { display_name: 'Fable' } },
            },
          ],
          extra_usage: null,
        },
      },
    }),
    JSON.stringify({ type: 'result', result: 'Current session: 12% used' }),
  ].join('\n')
  const stats = parseOfficialCcStats(lines)
  assert.equal(stats.ok, true)
  assert.equal(stats.limits_present, true)
  assert.equal(stats.five_hour.utilization, 0.12)
  assert.equal(stats.seven_day.utilization, 0.34)
  assert.equal(stats.seven_day_oi.utilization, 0.21)
  assert.equal(stats.seven_day_oi.resets_at, '2026-09-30T00:00:00Z')
})

test('stream-json /usage without limits is flagged incomplete', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', usage_report: { rate_limits: { limits: null } } }),
    JSON.stringify({ type: 'result', result: 'Total cost: $0.0000' }),
  ].join('\n')
  const stats = parseOfficialCcStats(lines)
  assert.equal(stats.ok, false)
  assert.equal(stats.limits_present, false)
})

test('2.1.28x /usage text rows map Fable to seven_day_oi', () => {
  const stats = parseOfficialCcStats(
    JSON.stringify({
      type: 'result',
      result:
        'You are currently using your subscription to power your Claude Code usage\n' +
        'Current session: 5% used · resets 8pm\n' +
        'Current week (all models): 40% used · resets Sep 30\n' +
        'Current week (Sonnet only): 3% used\n' +
        'Current week (Fable): 21% used · resets Sep 30',
    }),
  )
  assert.equal(stats.ok, true)
  assert.equal(stats.five_hour.utilization, 0.05)
  assert.equal(stats.seven_day.utilization, 0.4)
  assert.equal(stats.seven_day_sonnet.utilization, 0.03)
  assert.equal(stats.seven_day_oi.utilization, 0.21)
  assert.equal(stats.limits_present, true)
})

test('tierFromOauthProfile trusts has_claude_max / organization_type', async () => {
  const { tierFromOauthProfile } = await import('../../src/lib/oauth/official-cc-stats.mjs')
  assert.equal(tierFromOauthProfile({ account: { has_claude_max: true, has_claude_pro: false } }), 'max')
  assert.equal(tierFromOauthProfile({ organization: { organization_type: 'claude_max' } }), 'max')
  assert.equal(tierFromOauthProfile({ organization: { rate_limit_tier: 'default_claude_max_20x' } }), 'max')
  assert.equal(tierFromOauthProfile({ account: { has_claude_pro: true } }), 'pro')
  assert.equal(tierFromOauthProfile({ organization: { organization_type: 'claude_pro' } }), 'pro')
  assert.equal(tierFromOauthProfile({}), null)
})
