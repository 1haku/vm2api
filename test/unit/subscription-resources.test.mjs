import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SubscriptionsRepo } from '../../src/lib/db/repos/subscriptions-repo.mjs'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import {
  selectSubscriptionResource,
  subscriptionApiOptions,
  subscriptionRoute,
  canFallbackToSubscriptionApi,
} from '../../src/lib/admin/subscription-resources.mjs'
import { resolveInferenceBackend } from '../../src/lib/pool/api-protocol.mjs'
import { subscriptionSnapshot, assertSubscriptionSnapshot } from '../../src/lib/db/subscription-snapshot.mjs'

function setup(t, fields = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-sub-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare(
    "INSERT INTO users(id,email,username,password_hash,role,status) VALUES('u','u@example.test','u','unused','user','active')",
  ).run()
  db.prepare("INSERT INTO vms(id,name,vm_json) VALUES('slot','slot','{}')").run()
  const scheduler = new ApiScheduler()
  const endpoints = ['a', 'b', 'private'].map((id) => ({
    id,
    name: id,
    protocol: 'anthropic',
    kind: 'custom',
    base_url: 'https://unused.invalid',
    models: [{ alias: 'claude-sonnet-4-6', name: 'claude-opus-4-6' }],
    api_key_entries: [{ id: 'key-' + id, api_key: 'unused' }],
  }))
  for (const ep of endpoints)
    db.prepare('INSERT INTO api_endpoints(id,name,base_url,protocol) VALUES(?,?,?,?)').run(
      ep.id,
      ep.name,
      ep.base_url,
      ep.protocol,
    )
  scheduler.reload(endpoints)
  const repo = new SubscriptionsRepo(db)
  const plan = repo.savePlan(
    {
      name: 'mixed',
      vm_ids: ['slot'],
      daily_limit_usd: 10,
      weekly_limit_usd: 20,
      subscription_concurrency: 1,
      api_endpoints: [
        { endpoint_id: 'a', priority: 10 },
        { endpoint_id: 'b', priority: 0 },
      ],
      ...fields,
    },
    'admin',
  )
  repo.assign({ group_id: plan.id, user_ids: ['u'] }, 'admin')
  const req = {
    apiKeyKind: 'managed',
    apiKeyRecord: { id: 'k', user_id: 'u', group_id: plan.id, category: 'oauth' },
    headers: {},
  }
  return { db, repo, plan, req, scheduler }
}

test('mixed resources preserve existing keys; API-only cannot borrow unrelated slots or endpoints', (t) => {
  const { db, repo, plan, req, scheduler } = setup(t)
  assert.equal(selectSubscriptionResource(req, db, scheduler, 'claude-sonnet-4-6').backend, 'oauth')
  repo.savePlan({ vm_ids: [], resource_preference: 'api_first' }, 'admin', plan.id)
  const route = selectSubscriptionResource(req, db, scheduler, 'claude-sonnet-4-6')
  assert.equal(route.backend, 'api')
  assert.equal(route.picked.endpoint.id, 'a')
  assert.deepEqual(route.sub.vmIds, [])
  assert.equal(resolveInferenceBackend(req), 'api')
  assert.equal(
    resolveInferenceBackend({ ...req, [subscriptionRoute]: undefined, headers: { 'x-subscription-backend': 'api' } }),
    'oauth',
  )
  scheduler.endpoints[0].disabled = true
  assert.equal(selectSubscriptionResource(req, db, scheduler, 'claude-sonnet-4-6').picked.endpoint.id, 'b')
  scheduler.endpoints[1].disabled = true
  assert.throws(() => selectSubscriptionResource(req, db, scheduler, 'claude-sonnet-4-6'), /no api endpoint/)
})

test('endpoint binding priority, catalog and plan model allowlist fail closed', (t) => {
  const { db, repo, plan, req, scheduler } = setup(t, { resource_models: ['claude-sonnet-4-6'] })
  const options = subscriptionApiOptions(repo.entitlement(req.apiKeyRecord))
  for (let i = 0; i < 6; i++) assert.equal(scheduler.pick('claude-sonnet-4-6', Date.now(), options).endpoint.id, 'a')
  assert.equal(scheduler.pick('claude-opus-4-6', Date.now(), options).ok, false)
  assert.equal(scheduler.catalog({ ...options, endpointBindings: [] }).data.length, 0)
  assert.deepEqual(
    scheduler.catalog(options).data.map((m) => m.id),
    ['claude-sonnet-4-6'],
  )
  assert.throws(() => selectSubscriptionResource(req, db, scheduler, 'claude-opus-4-6'), /授权范围/)
  assert.throws(() => repo.savePlan({ platform: 'openai' }, 'admin', plan.id), /平台不一致/)
  db.prepare("DELETE FROM api_endpoints WHERE id='a'").run()
  assert.deepEqual(
    repo.apiResources(plan.id).map((e) => ({ ...e })),
    [{ endpoint_id: 'b', priority: 0 }],
  )
})

test('fallback reprices the same reservation atomically without a second concurrency seat or charge', (t) => {
  const { db, repo, req } = setup(t, { daily_limit_usd: 0.5 })
  const cheap = { model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: 'hello' }] }
  const first = repo.reserve(req.apiKeyRecord, 'request', cheap)
  assert.throws(() => repo.reserve(req.apiKeyRecord, 'second', cheap), /并发/)
  const costly = repo.reserve(
    req.apiKeyRecord,
    'request',
    { ...cheap, model: 'claude-opus-4-6' },
    { replace: true, requestedModel: cheap.model },
  )
  assert.ok(costly.reserved > first.reserved)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM custom_subscription_reservations').get().n, 1)
  assert.throws(
    () =>
      repo.reserve(
        req.apiKeyRecord,
        'request',
        { ...cheap, model: 'claude-opus-4-6', max_tokens: 1000000 },
        { replace: true },
      ),
    /额度/,
  )
  assert.equal(db.prepare('SELECT amount FROM custom_subscription_reservations').get().amount, costly.reserved)
  repo.settle('request', first.id, 0.03)
  repo.settle('request', first.id, 0.03)
  assert.equal(repo.list('u')[0].daily_used, 0.03)
  assert.equal(repo.list('u')[0].weekly_used, 0.03)
  assert.throws(() => repo.reserve(req.apiKeyRecord, 'request', cheap, { replace: true }), /失效/)
})

test('fallback never retries committed, billed, cancelled, policy or local limit errors', (t) => {
  const { db, req, scheduler } = setup(t, { api_fallback: true })
  selectSubscriptionResource(req, db, scheduler, 'claude-sonnet-4-6')
  assert.equal(canFallbackToSubscriptionApi(req, {}, { status: 503 }), true)
  for (const result of [
    { status: 400 },
    { status: 403 },
    { status: 503, committed: true },
    { status: 429, code: 'subscription_quota' },
    { status: 503, code: 'refusal_guard' },
    { status: 429, code: 'user_concurrency' },
    { status: 502, usage: { output_tokens: 1 } },
  ])
    assert.equal(canFallbackToSubscriptionApi(req, {}, result), false, JSON.stringify(result))
  assert.equal(canFallbackToSubscriptionApi(req, { headersSent: true }, { status: 503 }), false)
  assert.equal(canFallbackToSubscriptionApi({ ...req, aborted: true }, {}, { status: 503 }), false)
})

test('migration preservation includes resource bindings and defaults, detects tampering', (t) => {
  const { db } = setup(t)
  const before = subscriptionSnapshot(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  db.prepare("UPDATE custom_subscription_api_endpoints SET priority=99 WHERE endpoint_id='a'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /business data/)
})
