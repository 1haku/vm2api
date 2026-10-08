import crypto from 'node:crypto'

const exists = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
const digest = (rows) =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify(
        rows
          .map((row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      ),
    )
    .digest('hex')

// Keep secrets in memory only. Reports contain counts and hashes, never raw rows.
export function subscriptionSnapshot(db) {
  const tables = ['users', 'api_keys', 'groups', 'vms', 'usage_logs', 'proxies']
  const state = {}
  for (const table of tables) {
    const rows = db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => {
        // Nullable upstream additions: missing pre-upgrade fields and NULLs are equivalent.
        if (table === 'usage_logs')
          return {
            ...row,
            session_id: row.session_id ?? null,
            reasoning_effort: row.reasoning_effort ?? null,
            outbound_session_id: row.outbound_session_id ?? null,
            intercept: row.intercept ?? null,
          }
        if (table === 'proxies') return { ...row, label: row.label ?? null }
        // Upstream 032 adds these defaults; existing subscription scope still applies.
        if (table === 'api_keys')
          return { ...row, group_type: row.group_type ?? 'all', allowed_vms: row.allowed_vms ?? '[]' }
        return row
      })
    state[table] = { count: rows.length, hash: digest(rows) }
  }
  for (const table of ['refusal_guards', 'refusal_device_blocks']) {
    const rows = exists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all() : []
    const normalized =
      table === 'refusal_guards' ? rows.map((row) => ({ ...row, signature: row.signature ?? null })) : rows
    state[table] = { count: rows.length, hash: digest(normalized) }
  }
  for (const name of [
    'subscription_slots',
    'user_subscriptions',
    'subscription_events',
    'subscription_reservations',
    'subscription_ledger',
    'response_owners',
  ]) {
    const table = exists(db, 'custom_' + name) ? 'custom_' + name : name
    const rows = db
      .prepare(`SELECT ${name === 'subscription_ledger' ? 'rowid AS sequence,' : ''}* FROM ${table}`)
      .all()
      .map((row) => (name === 'user_subscriptions' ? { ...row, reset_ledger_rowid: row.reset_ledger_rowid ?? 0 } : row))
    state[name] = { count: rows.length, hash: digest(rows) }
  }
  const plans = exists(db, 'custom_subscription_plans')
    ? db.prepare('SELECT * FROM custom_subscription_plans').all()
    : db
        .prepare(
          'SELECT id AS group_id,daily_limit_usd,weekly_limit_usd,default_validity_days,subscription_concurrency FROM groups WHERE subscription_enabled=1',
        )
        .all()
  state.plans = {
    count: plans.length,
    hash: digest(
      plans.map((row) => ({
        ...row,
        group_rpm_limit: row.group_rpm_limit ?? 0,
        user_rpm_limit: row.user_rpm_limit ?? 0,
      })),
    ),
  }
  const userLimits = exists(db, 'custom_user_request_limits')
    ? db.prepare('SELECT * FROM custom_user_request_limits').all()
    : db
        .prepare(
          "SELECT id AS user_id,CASE WHEN role='admin' THEN 0 ELSE concurrency END AS concurrency,0 AS rpm_limit FROM users",
        )
        .all()
  state.user_limits = { count: userLimits.length, hash: digest(userLimits) }
  const rpmEvents = exists(db, 'custom_request_rpm_events')
    ? db.prepare('SELECT * FROM custom_request_rpm_events').all()
    : []
  state.rpm_events = { count: rpmEvents.length, hash: digest(rpmEvents) }
  return state
}

export function assertSubscriptionSnapshot(before, after) {
  for (const [name, value] of Object.entries(before)) {
    if (value.count !== after[name]?.count || value.hash !== after[name]?.hash)
      throw new Error(`Subscription migration changed business data: ${name}`)
  }
}

export function verifySubscriptionSchema(db) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Database integrity check failed')
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Database foreign key check failed')
  for (const name of [
    'custom_subscription_plans',
    'custom_subscription_slots',
    'custom_user_subscriptions',
    'custom_subscription_events',
    'custom_subscription_reservations',
    'custom_subscription_ledger',
    'custom_response_owners',
    'custom_user_request_limits',
    'custom_request_rpm_events',
  ]) {
    if (!exists(db, name)) throw new Error(`Missing subscription table: ${name}`)
  }
  if (!db.prepare("SELECT 1 FROM custom_schema_migrations WHERE version='002'").get())
    throw new Error('Custom migration 002 missing')
  if (!db.prepare("SELECT 1 FROM custom_schema_migrations WHERE version='003'").get())
    throw new Error('Custom migration 003 missing')
  if (!db.prepare("SELECT 1 FROM custom_schema_migrations WHERE version='004'").get())
    throw new Error('Custom migration 004 missing')
}
