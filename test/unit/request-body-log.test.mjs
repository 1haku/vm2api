import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { applyCustomMigrations } from '../../src/lib/db/custom-migrations.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { UsageLogsView, toUsageLogRow } from '../../src/lib/db/repos/usage-logs-view.mjs'
import { armWriteBehind, flushWrites } from '../../src/lib/db/write-behind.mjs'

function freshDb(t) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  return db
}

function setup(t, mode = 'normal') {
  const db = freshDb(t)
  const store = new RequestLogStore({ db, mode, jsonlMirror: false })
  const ctx = store.start(
    { method: 'POST', url: '/v1/messages', headers: {}, socket: {} },
    { protocol: 'anthropic.messages' },
  )
  return { db, store, ctx, view: new UsageLogsView(db) }
}

function metrics(overrides = {}) {
  return {
    expected_bytes: 1024,
    received_bytes: 1024,
    read_ms: 23.75,
    parse_ms: 0.5,
    complete: true,
    error_code: null,
    ...overrides,
  }
}

test('body metrics remain queryable without debug and never copy body or headers', (t) => {
  const { db, store, ctx, view } = setup(t)
  const expected = metrics()
  const supplied = {
    ...expected,
    body: 'private-body-sentinel',
    headers: { authorization: 'private-header-sentinel' },
  }
  supplied.extra = supplied // Unknown fields must not even be serialized.
  const summary = store.finish(ctx, {
    status: 200,
    request_body_metrics: supplied,
    inbound_body: { content: 'private-body-sentinel' },
    outbound_headers: { authorization: 'private-header-sentinel' },
  })
  assert.deepEqual(JSON.parse(summary.custom_request_body_metrics), expected)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM request_log_debug').get().n, 0)
  const stored = db.prepare('SELECT * FROM usage_logs WHERE request_id = ?').get(ctx.request_id)
  assert.equal(typeof stored.custom_request_body_metrics, 'string')
  assert.deepEqual(JSON.parse(stored.custom_request_body_metrics), expected)
  assert.doesNotMatch(JSON.stringify(stored), /private-(body|header)-sentinel/)
  assert.doesNotMatch(JSON.stringify(summary), /private-(body|header)-sentinel/)
  const reopenedStore = new RequestLogStore({ db, mode: 'normal', jsonlMirror: false })
  assert.deepEqual(JSON.parse(reopenedStore.queryNormal().items[0].custom_request_body_metrics), expected)
  assert.deepEqual(view.listBatch().logs[0].requestBodyMetrics, expected)
})

test('debug stores a metrics object with exactly the same six scalar fields', (t) => {
  const { store, ctx, view } = setup(t, 'debug')
  const expected = metrics({ expected_bytes: null })
  store.finish(ctx, {
    status: 200,
    request_body_metrics: {
      ...expected,
      body: 'private-body-sentinel',
      headers: { custom: 'private-header-sentinel' },
    },
  })
  const debug = store.repo.getDebug(ctx.request_id)
  assert.deepEqual(debug.request_body_metrics, expected)
  assert.equal(typeof debug.request_body_metrics, 'object')
  assert.deepEqual(JSON.parse(debug.custom_request_body_metrics), expected)
  assert.doesNotMatch(JSON.stringify(debug), /private-(body|header)-sentinel/)
  assert.deepEqual(view.listBatch().logs[0].requestBodyMetrics, expected)
})

test('logs without body metrics and pre-migration row objects expose null', (t) => {
  const { store, ctx, view } = setup(t)
  store.finish(ctx, { status: 200 })
  assert.equal(store.repo.getByRequestId(ctx.request_id).custom_request_body_metrics, null)
  assert.equal(view.listBatch().logs[0].requestBodyMetrics, null)
  const names = { users: new Map(), keys: new Map(), vms: new Map(), accounts: new Map() }
  assert.equal(toUsageLogRow({ id: 'legacy' }, names).requestBodyMetrics, null)
})

test('incomplete uploads retain bytes, timings and error codes without rewriting status', (t) => {
  const { store, view } = setup(t)
  const cases = [
    { status: 499, final_state: 'cancelled', error_code: 'request_aborted', received_bytes: 81 },
    { status: 413, final_state: 'failed', error_code: 'request_body_too_large', received_bytes: 2048 },
  ]
  for (const entry of cases) {
    const ctx = store.start({ method: 'POST', url: '/v1/messages', headers: {}, socket: {} })
    const expected = metrics({
      received_bytes: entry.received_bytes,
      read_ms: 1200.25,
      parse_ms: 0,
      complete: false,
      error_code: entry.error_code,
    })
    store.finish(ctx, { ...entry, request_body_metrics: expected })
    const row = view.listBatch({ include_muted: true }).logs.find((r) => r.requestId === ctx.request_id)
    assert.deepEqual(row.requestBodyMetrics, expected)
    assert.equal(row.statusCode, entry.status)
    assert.equal(row.finalState, entry.final_state)
    assert.equal(row.errorCode, entry.error_code)
  }
})

test('unknown or zero declared length and zero timings survive without truthy fallbacks', (t) => {
  const { store, view } = setup(t)
  for (const expected_bytes of [null, 0]) {
    const ctx = store.start({ headers: {}, socket: {} })
    const expected = metrics({ expected_bytes, received_bytes: 0, read_ms: 0, parse_ms: 0 })
    store.finish(ctx, { status: 200, request_body_metrics: expected })
    const row = view.listBatch().logs.find((r) => r.requestId === ctx.request_id)
    assert.deepEqual(row.requestBodyMetrics, expected)
  }
})

test('parse failures preserve complete reception and their own timing', (t) => {
  const { db, store, ctx, view } = setup(t)
  const expected = metrics({ parse_ms: 2.25, error_code: 'invalid_json' })
  store.finish(ctx, { status: 400, request_body_metrics: expected })
  const row = view.listBatch({ include_muted: true }).logs[0]
  assert.deepEqual(row.requestBodyMetrics, expected)
  assert.equal(row.statusCode, 400)
  assert.equal(db.prepare('SELECT error_code FROM usage_logs').get().error_code, null)
  assert.notEqual(row.errorCode, expected.error_code, 'metrics error_code must not replace the main request error')
})

test('deferred writes snapshot metrics at finish for both summary and debug', (t) => {
  const { db, store, ctx, view } = setup(t, 'debug')
  const supplied = metrics({ received_bytes: 70, complete: false, error_code: 'request_aborted' })
  const expected = { ...supplied }
  armWriteBehind(db)
  try {
    store.finish(ctx, { status: 499, request_body_metrics: supplied })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get().n, 0)
    supplied.received_bytes = 1024
    supplied.complete = true
    supplied.error_code = null
    flushWrites()
    assert.deepEqual(view.listBatch({ include_muted: true }).logs[0].requestBodyMetrics, expected)
    assert.deepEqual(store.repo.getDebug(ctx.request_id).request_body_metrics, expected)
  } finally {
    flushWrites()
    armWriteBehind(null)
  }
})

test('invalid stored metrics do not break log queries or leak non-scalar values', (t) => {
  const { db, store, ctx, view } = setup(t)
  store.finish(ctx, { status: 200 })
  const update = db.prepare('UPDATE usage_logs SET custom_request_body_metrics = ? WHERE request_id = ?')
  const invalid = [
    'not-json',
    'null',
    '[]',
    '{}',
    JSON.stringify(metrics({ received_bytes: 'private-body-sentinel' })),
    JSON.stringify(metrics({ expected_bytes: -1 })),
    JSON.stringify(metrics({ read_ms: null })),
    JSON.stringify(metrics({ parse_ms: -1 })),
    JSON.stringify(metrics({ complete: 'false' })),
    JSON.stringify(metrics({ error_code: { body: 'private-body-sentinel' } })),
  ]
  for (const value of invalid) {
    update.run(value, ctx.request_id)
    assert.equal(view.listBatch().logs[0].requestBodyMetrics, null)
  }
})

test('custom migration 009 preserves old rows and is idempotent with populated metrics', (t) => {
  const db = freshDb(t)
  db.exec('ALTER TABLE usage_logs DROP COLUMN custom_request_body_metrics')
  db.exec("DELETE FROM custom_schema_migrations WHERE version = '009'")
  db.prepare('INSERT INTO usage_logs (id, request_id, created_at, status, total_cost) VALUES (?, ?, ?, ?, ?)').run(
    'old',
    'old-request',
    new Date().toISOString(),
    200,
    1.25,
  )
  const oldRow = { ...db.prepare('SELECT * FROM usage_logs').get() }
  const upstreamMigrations = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
  assert.deepEqual(applyCustomMigrations(db), ['custom/009_request_body_metrics.sql'])
  assert.deepEqual(
    { ...db.prepare('SELECT * FROM usage_logs').get() },
    { ...oldRow, custom_request_body_metrics: null },
  )
  assert.equal(new UsageLogsView(db).listBatch().logs[0].requestBodyMetrics, null)
  const column = db
    .prepare('PRAGMA table_info(usage_logs)')
    .all()
    .find((c) => c.name === 'custom_request_body_metrics')
  assert.equal(column.type, 'TEXT')
  assert.equal(column.notnull, 0)
  const expected = metrics({ complete: false, error_code: 'request_aborted' })
  new UsageLogsRepo(db).insertSummary({
    id: 'new',
    request_id: 'new-request',
    created_at: new Date().toISOString(),
    status: 499,
    custom_request_body_metrics: JSON.stringify(expected),
  })
  const before = db.prepare('SELECT * FROM usage_logs ORDER BY id').all()
  assert.deepEqual(applyCustomMigrations(db), [])
  assert.deepEqual(applyMigrations(db), [])
  assert.deepEqual(db.prepare('SELECT * FROM usage_logs ORDER BY id').all(), before)
  assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), upstreamMigrations)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM custom_schema_migrations WHERE version = '009'").get().n, 1)
  const rows = new UsageLogsView(db).listBatch({ include_muted: true }).logs
  assert.deepEqual(rows.find((r) => r.id === 'new').requestBodyMetrics, expected)
  assert.equal(rows.find((r) => r.id === 'old').requestBodyMetrics, null)
})
