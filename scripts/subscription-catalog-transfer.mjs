// Transfer only identities and unassigned plan definitions; never slot credentials,
// API keys, memberships, usage, sessions, settings or the old database key.
import fs from 'node:fs'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase, withTransaction } from '../src/lib/db/database.mjs'
import { UsersRepo } from '../src/lib/db/repos/users-repo.mjs'
import { RequestLimitsRepo } from '../src/lib/db/repos/request-limits-repo.mjs'
import { ImagePermissionsRepo } from '../src/lib/db/repos/image-permissions-repo.mjs'
import { SubscriptionsRepo } from '../src/lib/db/repos/subscriptions-repo.mjs'

const PLAN_FIELDS = [
  'name',
  'description',
  'platform',
  'rate_multiplier',
  'daily_limit_usd',
  'weekly_limit_usd',
  'default_validity_days',
  'subscription_concurrency',
  'group_rpm_limit',
  'user_rpm_limit',
]
const EMPTY_TABLES = [
  'users',
  'api_keys',
  'vms',
  'accounts',
  'custom_subscription_plans',
  'custom_user_subscriptions',
  'custom_subscription_slots',
  'custom_subscription_ledger',
  'usage_logs',
]
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message)
}

export function exportCatalog(db) {
  const users = db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY id').all()
  const allowed = new Set(users.map((u) => u.id))
  const limits = db
    .prepare('SELECT user_id,concurrency,rpm_limit FROM custom_user_request_limits ORDER BY user_id')
    .all()
    .filter((r) => allowed.has(r.user_id))
  const images = db
    .prepare('SELECT * FROM custom_user_image_permissions ORDER BY user_id')
    .all()
    .filter((r) => allowed.has(r.user_id))
  const plans = new SubscriptionsRepo(db)
    .plans()
    .map((p) => ({
      source_id: p.id,
      ...Object.fromEntries(PLAN_FIELDS.map((k) => [k, p[k]])),
      requires_weekly_reference: p.weekly_reset_mode === 'slot',
    }))
  return { schema: 1, exported_at: new Date().toISOString(), users, limits, images, plans }
}

export function importCatalog(db, data) {
  requireValue(
    data?.schema === 1 && ['users', 'limits', 'images', 'plans'].every((k) => Array.isArray(data[k])),
    'Invalid catalog envelope',
  )
  requireValue(
    data.users.length > 0 && data.users.length <= 10000 && data.plans.length <= 10000,
    'Invalid catalog size',
  )
  requireValue(
    data.users.some((u) => u.role === 'admin' && u.status === 'active'),
    'Catalog requires an active admin',
  )
  for (const table of EMPTY_TABLES)
    requireValue(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n === 0, `Destination is not empty: ${table}`)
  return withTransaction(db, () => {
    const users = new UsersRepo(db),
      limits = new RequestLimitsRepo(db),
      images = new ImagePermissionsRepo(db),
      plans = new SubscriptionsRepo(db)
    for (const u of data.users) {
      requireValue(
        typeof u.id === 'string' &&
          typeof u.username === 'string' &&
          typeof u.password_hash === 'string' &&
          u.password_hash.length > 20,
        'Invalid user identity',
      )
      requireValue(
        ['admin', 'user'].includes(u.role) && ['active', 'disabled'].includes(u.status),
        'Invalid user state',
      )
      const saved = users.insert(u)
      requireValue(hash(saved.password_hash) === hash(u.password_hash), 'Password preservation failed')
    }
    for (const l of data.limits) {
      const user = users.getById(l.user_id)
      requireValue(!!user, 'Unknown limit owner')
      limits.saveUser(user, { concurrency: l.concurrency, rpm_limit: l.rpm_limit })
    }
    for (const row of data.images) {
      requireValue(!!users.getById(row.user_id), 'Unknown image permission owner')
      images.save(row.user_id, !!row.enabled)
    }
    const imported = []
    for (const p of data.plans) {
      const saved = plans.savePlan(
        {
          ...Object.fromEntries(PLAN_FIELDS.map((k) => [k, p[k]])),
          status: 'disabled',
          vm_ids: [],
          weekly_reset_mode: 'independent',
          weekly_reset_vm_id: null,
        },
        'catalog-transfer',
      )
      for (const key of PLAN_FIELDS) requireValue((saved[key] ?? '') === (p[key] ?? ''), `Plan field mismatch: ${key}`)
      imported.push({
        source_id: p.source_id,
        id: saved.id,
        name: saved.name,
        status: saved.status,
        requires_weekly_reference: p.requires_weekly_reference === true,
      })
    }
    requireValue(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'Foreign key check failed')
    for (const table of [
      'vms',
      'accounts',
      'api_keys',
      'custom_user_subscriptions',
      'custom_subscription_slots',
      'custom_subscription_ledger',
      'usage_logs',
    ])
      requireValue(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n === 0, `Unexpected imported data: ${table}`)
    return {
      users: data.users.map((u) => u.username),
      plans: imported,
      passwordsPreserved: true,
      memberships: 0,
      slots: 0,
      apiKeys: 0,
      usageRows: 0,
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, database, file] = process.argv.slice(2)
  requireValue(
    ['export', 'import'].includes(action) && database && file,
    'Usage: subscription-catalog-transfer.mjs export|import DATABASE FILE',
  )
  const db = action === 'export' ? new DatabaseSync(database, { readOnly: true }) : createDatabase({ dbPath: database })
  try {
    if (action === 'export') {
      db.exec('BEGIN')
      const data = exportCatalog(db)
      db.exec('COMMIT')
      fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600, flag: 'wx' })
      console.log(
        JSON.stringify({
          exportedUsers: data.users.length,
          exportedPlans: data.plans.length,
          catalogDigest: hash(data),
        }),
      )
    } else {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      console.log(JSON.stringify({ ...importCatalog(db, data), catalogDigest: hash(data) }))
    }
  } finally {
    db.close()
  }
}
