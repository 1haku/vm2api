import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'
import { legacySubscriptionDatabase } from '../subscription-legacy-fixture.mjs'
import {
  subscriptionSnapshot,
  assertSubscriptionSnapshot,
  verifySubscriptionSchema,
} from '../../src/lib/db/subscription-snapshot.mjs'
import { SubscriptionsRepo } from '../../src/lib/db/repos/subscriptions-repo.mjs'

test('v3 data migrates without changing ownership, amounts, limits or history; tampering with same row count is detected', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-content-'))
  let db = legacySubscriptionDatabase(dir)
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO users(id,email,username,password_hash,role,status) VALUES('a','a@example.test','a','unused','user','active')",
  ).run()
  db.prepare("INSERT INTO vms(id,name,vm_json) VALUES('slot','slot','{}')").run()
  db.prepare(
    "INSERT INTO groups(id,name,subscription_enabled,daily_limit_usd,weekly_limit_usd) VALUES(9,'Legacy plan',1,30,100)",
  ).run()
  db.prepare("INSERT INTO api_keys(id,key,name,user_id,group_id) VALUES('key','unused','my-key','a',9)").run()
  db.prepare("INSERT INTO subscription_slots VALUES(9,'slot')").run()
  db.prepare(
    "INSERT INTO user_subscriptions(id,user_id,group_id,starts_at,expires_at,reset_at,created_at,updated_at) VALUES('sub','a',9,?,?,?,?,?)",
  ).run(now, '2099-01-01T00:00:00.000Z', now, now, now)
  db.prepare("INSERT INTO subscription_ledger VALUES('settled','sub',3.125,?)").run(now)
  db.prepare("INSERT INTO subscription_reservations VALUES('pending','sub',0.5,?)").run(now)
  db.prepare("INSERT INTO response_owners VALUES('response','a',9,'slot',?)").run(now)
  db.prepare("INSERT INTO subscription_events(action,detail,created_at) VALUES('assigned','{}',?)").run(now)
  const before = subscriptionSnapshot(db)
  db.close()
  db = createDatabase({ dataDir: dir })
  verifySubscriptionSchema(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  const repo = new SubscriptionsRepo(db)
  assert.equal(repo.entitlement({ user_id: 'a', group_id: 9 }).group.daily_limit_usd, 30)
  assert.equal(repo.responseOwner('response', { user_id: 'a', group_id: 9 }).vm_id, 'slot')
  db.prepare('UPDATE custom_subscription_plans SET daily_limit_usd=31 WHERE group_id=9').run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /plans/)
  db.prepare('UPDATE custom_subscription_plans SET daily_limit_usd=30 WHERE group_id=9').run()
  db.prepare("UPDATE custom_subscription_ledger SET amount=4 WHERE request_id='settled'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /subscription_ledger/)
  db.prepare("UPDATE custom_subscription_ledger SET amount=3.125 WHERE request_id='settled'").run()
  db.prepare("UPDATE custom_response_owners SET user_id='b'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /response_owners/)
  repo.savePlan({ daily_limit_usd: 45 }, 'admin', 9)
  assert.equal(db.prepare('SELECT daily_limit_usd FROM groups WHERE id=9').get().daily_limit_usd, 30)
  assert.equal(repo.plans()[0].daily_limit_usd, 45)
})

test('fresh install uses independent migration namespace and leaves upstream 027 free', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-migrations-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(db.prepare("SELECT version FROM schema_migrations WHERE version='027'").get(), undefined)
  assert.equal(
    db.prepare("SELECT name FROM custom_schema_migrations WHERE version='001'").get().name,
    '001_subscriptions.sql',
  )
  const upstream = path.join(dir, 'upstream')
  fs.mkdirSync(upstream)
  fs.writeFileSync(path.join(upstream, '027_future.sql'), 'CREATE TABLE future_upstream(id TEXT);')
  applyMigrations(db, { migrationsDir: upstream })
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version='027'").get().name, '027_future.sql')
})

test('deployed v1 stamp is adopted without replaying SQL or losing subscriptions', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-subscriptions-'))
  let db = legacySubscriptionDatabase(dir, { v1: true })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare('INSERT INTO subscription_events(action,detail,created_at) VALUES(?,?,?)').run(
    'sentinel',
    '{}',
    new Date().toISOString(),
  )
  db.close()
  db = createDatabase({ dataDir: dir })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='027'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_schema_migrations').get().n, 2)
  assert.equal(db.prepare('SELECT action FROM custom_subscription_events').get().action, 'sentinel')
})

test('modified legacy migration fails closed and retains the legacy stamp', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-subscriptions-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run('027', '027_subscriptions.sql', 'invalid', 'now')
  assert.throws(() => applyMigrations(db), /checksum mismatch/)
  assert.equal(db.prepare("SELECT checksum FROM schema_migrations WHERE version='027'").get().checksum, 'invalid')
})
