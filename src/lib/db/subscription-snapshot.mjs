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
        // 027/028 only add nullable fields. Missing pre-upgrade fields and new NULLs are equivalent.
        if (table === 'usage_logs')
          return { ...row, session_id: row.session_id ?? null, reasoning_effort: row.reasoning_effort ?? null }
        if (table === 'proxies') return { ...row, label: row.label ?? null }
        return row
      })
    state[table] = { count: rows.length, hash: digest(rows) }
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
  state.plans = { count: plans.length, hash: digest(plans) }
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
  ]) {
    if (!exists(db, name)) throw new Error(`Missing subscription table: ${name}`)
  }
  if (!db.prepare("SELECT 1 FROM custom_schema_migrations WHERE version='002'").get())
    throw new Error('Custom migration 002 missing')
}
