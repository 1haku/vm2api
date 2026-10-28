import crypto from 'node:crypto'
import fs from 'node:fs'

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
  const normalizedBilling = !!db.prepare("SELECT 1 FROM schema_migrations WHERE version='037'").get()
  // Compare pre-037 logs in the exact representation produced by the reviewed migration.
  // All other fields (in particular actual/official costs and ownership) remain hash-checked.
  const migration = fs.readFileSync(
    new URL('./migrations/037_usage_logs_billing_normalize.sql', import.meta.url),
    'utf8',
  )
  const rewrite = migration.match(/UPDATE usage_logs\s+SET input_tokens = ([\s\S]+?)\s+WHERE ([\s\S]+?);/)
  if (!rewrite) throw new Error('Cannot verify migration 037 input normalization')
  const tables = ['users', 'api_keys', 'groups', 'vms', 'usage_logs', 'proxies']
  const state = {}
  for (const table of tables) {
    const rows = db
      .prepare(
        table === 'usage_logs' && !normalizedBilling
          ? `SELECT *, CASE WHEN ${rewrite[2]} THEN ${rewrite[1]} ELSE input_tokens END AS __expected_input FROM usage_logs`
          : `SELECT * FROM ${table}`,
      )
      .all()
      .map((row) => {
        // Nullable upstream additions: missing pre-upgrade fields and NULLs are equivalent.
        if (table === 'usage_logs') {
          if (!normalizedBilling) {
            row.input_tokens = row.__expected_input
            delete row.__expected_input
          }
          return {
            ...row,
            session_id: row.session_id ?? null,
            reasoning_effort: row.reasoning_effort ?? null,
            outbound_session_id: row.outbound_session_id ?? null,
            // Upstream 041 adds only a nullable inbound device identifier.
            inbound_device_id: row.inbound_device_id ?? null,
            image_model: row.image_model ?? null,
            image_usage: row.image_usage ?? null,
            image_input_tokens: row.image_input_tokens ?? 0,
            image_output_tokens: row.image_output_tokens ?? 0,
            image_cost: row.image_cost ?? null,
            // Upstream 043/044 add measured timing and audit context; historical
            // rows stay unknown. Non-null changes must still fail the hash check.
            first_byte_ms: row.first_byte_ms ?? null,
            generation_ms: row.generation_ms ?? null,
            jev_state: row.jev_state ?? null,
            upstream_service_tier: row.upstream_service_tier ?? null,
            intercept: row.intercept ?? null,
            vm_owner_user_id: row.vm_owner_user_id ?? null,
            web_search_requests: row.web_search_requests ?? 0,
            web_search_cost: row.web_search_cost ?? null,
            price_source: row.price_source ?? null,
            price_version: row.price_version ?? null,
          }
        }
        if (table === 'proxies') {
          const normalized = { ...row, label: row.label ?? null, domain_forward: row.domain_forward ?? 0 }
          // Upstream 033: newly added IPv6 geo fields are nullable, not rewritten data.
          for (const field of [
            'ip',
            'country',
            'country_code',
            'region',
            'city',
            'isp',
            'timezone',
            'checked_at',
            'error',
          ]) {
            const key = `geo_v6_${field}`
            normalized[key] = row[key] ?? null
          }
          return normalized
        }
        // Upstream 032 adds these defaults; existing subscription scope still applies.
        if (table === 'api_keys')
          return {
            ...row,
            group_type: row.group_type ?? 'all',
            allowed_vms: row.allowed_vms ?? '[]',
            vm_pool_id: row.vm_pool_id ?? null,
          }
        return row
      })
    state[table] = { count: rows.length, hash: digest(rows) }
  }
  for (const table of [
    'refusal_guards',
    'refusal_device_blocks',
    'vm_pools',
    'vm_pool_members',
    'api_endpoints',
    'api_endpoint_keys',
    'api_endpoint_models',
    'cluster_nodes',
    'cluster_node_direct_links',
    'request_attempts',
  ]) {
    const rows = exists(db, table) ? db.prepare(`SELECT * FROM ${table}`).all() : []
    const normalized =
      table === 'refusal_guards'
        ? rows.map((row) => ({ ...row, signature: row.signature ?? null }))
        : table === 'api_endpoint_keys'
          ? rows.map((row) => ({ ...row, proxy_id: row.proxy_id ?? '' }))
          : table === 'request_attempts'
            ? rows.map((row) => ({
                ...row,
                queue_wait_ms: row.queue_wait_ms ?? null,
                scheduling_ms: row.scheduling_ms ?? null,
              }))
            : table === 'cluster_nodes'
              ? rows.map((row) => ({ ...row, platform: row.platform ?? 'linux' }))
              : rows
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
      .map((row) =>
        name === 'user_subscriptions'
          ? {
              ...row,
              reset_ledger_rowid: row.reset_ledger_rowid ?? 0,
              daily_quota_reset_at: row.daily_quota_reset_at ?? null,
              daily_reset_ledger_rowid: row.daily_reset_ledger_rowid ?? 0,
            }
          : row,
      )
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
        weekly_reset_mode: row.weekly_reset_mode ?? 'independent',
        weekly_reset_vm_id: row.weekly_reset_vm_id ?? null,
        weekly_window_start: row.weekly_window_start ?? null,
        weekly_window_end: row.weekly_window_end ?? null,
        weekly_source_account: row.weekly_source_account ?? null,
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
  const imagePermissions = exists(db, 'custom_user_image_permissions')
    ? db.prepare('SELECT * FROM custom_user_image_permissions').all()
    : []
  state.image_permissions = { count: imagePermissions.length, hash: digest(imagePermissions) }
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
  if (!db.prepare("SELECT 1 FROM custom_schema_migrations WHERE version='005'").get())
    throw new Error('Custom migration 005 missing')
  if (!db.prepare("SELECT 1 FROM custom_schema_migrations WHERE version='006'").get())
    throw new Error('Custom migration 006 missing')
  if (!db.prepare("SELECT 1 FROM custom_schema_migrations WHERE version='007'").get())
    throw new Error('Custom migration 007 missing')
}
