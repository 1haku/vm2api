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
import { RequestLimitsRepo } from '../../src/lib/db/repos/request-limits-repo.mjs'
import { applyCustomMigrations } from '../../src/lib/db/custom-migrations.mjs'

test('006 adds daily reset defaults without changing subscriptions and detects changed reset markers', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-reset-migration-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec("INSERT INTO users(id,email,username,password_hash) VALUES('daily-user','daily@test','daily','unused')")
  db.exec(
    "INSERT INTO custom_user_subscriptions(id,user_id,group_id,starts_at,expires_at,reset_at,created_at,updated_at) VALUES('daily-sub','daily-user',1,'2026-10-01','2026-11-01','2026-10-02','2026-10-01','2026-10-02')",
  )
  db.exec('ALTER TABLE custom_user_subscriptions DROP COLUMN daily_quota_reset_at')
  db.exec('ALTER TABLE custom_user_subscriptions DROP COLUMN daily_reset_ledger_rowid')
  db.exec("DELETE FROM custom_schema_migrations WHERE version='006'")
  const before = subscriptionSnapshot(db)
  applyCustomMigrations(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  const sub = db.prepare("SELECT * FROM custom_user_subscriptions WHERE id='daily-sub'").get()
  assert.equal(sub.daily_quota_reset_at, null)
  assert.equal(sub.daily_reset_ledger_rowid, 0)
  db.exec("UPDATE custom_user_subscriptions SET daily_reset_ledger_rowid=1 WHERE id='daily-sub'")
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)))
})

test('040/041 preserve node credentials and historical usage while adding only Linux/NULL defaults', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-device-migration-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec(
    "INSERT INTO cluster_nodes(id,label,host,username,auth_type,private_key,host_key_alg,host_key_sha256,created_at,updated_at) VALUES('node','fixture','192.0.2.5','operator','key','fixture-key','ssh-ed25519','fixture-pin','2026-10-20T00:00:00Z','2026-10-20T00:00:00Z')",
  )
  db.exec(
    "INSERT INTO usage_logs(id,request_id,created_at,user_id,actual_cost,total_cost,input_tokens) VALUES('old','old','2026-10-20T00:00:00Z','owner',1.25,1.25,100)",
  )
  db.exec('DROP INDEX idx_usage_logs_inbound_device')
  db.exec('ALTER TABLE usage_logs DROP COLUMN inbound_device_id')
  db.exec('ALTER TABLE cluster_nodes DROP COLUMN platform')
  db.exec("DELETE FROM schema_migrations WHERE version IN ('040','041')")
  const before = subscriptionSnapshot(db)
  applyMigrations(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  assert.equal(db.prepare("SELECT platform FROM cluster_nodes WHERE id='node'").get().platform, 'linux')
  assert.equal(db.prepare("SELECT inbound_device_id FROM usage_logs WHERE id='old'").get().inbound_device_id, null)
  db.exec("UPDATE usage_logs SET inbound_device_id='changed' WHERE id='old'")
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /usage_logs/)
  db.exec("UPDATE usage_logs SET inbound_device_id=NULL WHERE id='old'")
  db.exec("UPDATE cluster_nodes SET platform='darwin' WHERE id='node'")
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /cluster_nodes/)
  db.exec("UPDATE cluster_nodes SET platform='linux',private_key='changed' WHERE id='node'")
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /cluster_nodes/)
})

test('038 preserves API endpoint credentials and proxy routing while adding an empty proxy id', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-proxy-migration-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.exec("INSERT INTO api_endpoints(id,name,base_url) VALUES('ep','fixture','https://example.invalid')")
  db.exec(
    "INSERT INTO api_endpoint_keys(id,endpoint_id,api_key,proxy_url) VALUES('key','ep','fixture-only','socks5://example.invalid:1080')",
  )
  db.exec('ALTER TABLE api_endpoint_keys DROP COLUMN proxy_id')
  db.exec("DELETE FROM schema_migrations WHERE version='038'")
  const before = subscriptionSnapshot(db)
  applyMigrations(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  assert.equal(db.prepare("SELECT proxy_id FROM api_endpoint_keys WHERE id='key'").get().proxy_id, '')
  db.exec("UPDATE api_endpoint_keys SET proxy_id='different' WHERE id='key'")
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /api_endpoint_keys/)
})

test('037 snapshot permits only specified historical token conversion, not cost or ownership changes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-normalize-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const add = db.prepare(
    'INSERT INTO usage_logs(id,request_id,model,pricing_model,via,protocol,stream,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,total_cost,actual_cost,user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  )
  add.run(
    'gpt',
    'gpt',
    'gpt-6-astra',
    'gpt-6-astra',
    'codex-kernel',
    'openai.responses',
    1,
    100,
    5,
    60,
    10,
    1,
    2,
    'caller',
    '2026-10-13T00:00:00Z',
  )
  add.run(
    'claude',
    'claude',
    'claude-sonnet-5-5',
    'claude-sonnet-5-5',
    'go-worker-pool',
    'anthropic.messages',
    1,
    100,
    5,
    60,
    10,
    1,
    2,
    'caller',
    '2026-10-13T00:00:00Z',
  )
  add.run(
    'converted',
    'converted',
    'gpt-6-astra',
    'gpt-6-astra',
    'api-kernel',
    'anthropic.messages',
    0,
    100,
    5,
    60,
    10,
    1,
    2,
    'caller',
    '2026-10-13T00:00:00Z',
  )
  for (const column of ['web_search_requests', 'web_search_cost', 'price_source', 'price_version'])
    db.exec('ALTER TABLE usage_logs DROP COLUMN ' + column)
  db.prepare("DELETE FROM schema_migrations WHERE version='037'").run()
  const before = subscriptionSnapshot(db)
  applyMigrations(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  assert.equal(db.prepare("SELECT input_tokens FROM usage_logs WHERE id='gpt'").get().input_tokens, 30)
  assert.equal(db.prepare("SELECT input_tokens FROM usage_logs WHERE id='claude'").get().input_tokens, 100)
  assert.equal(db.prepare("SELECT input_tokens FROM usage_logs WHERE id='converted'").get().input_tokens, 100)
  db.prepare("UPDATE usage_logs SET actual_cost=3 WHERE id='gpt'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /usage_logs/)
  db.prepare("UPDATE usage_logs SET actual_cost=2,user_id='other' WHERE id='gpt'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /usage_logs/)
})

test('005 adds independent defaults without changing a v4 plan, and detects later cycle changes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-migration-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare("INSERT INTO groups(id,name,platform,status) VALUES(99,'Legacy','claude','active')").run()
  db.prepare('INSERT INTO custom_subscription_plans(group_id,daily_limit_usd,weekly_limit_usd) VALUES(99,30,100)').run()
  for (const column of [
    'weekly_reset_mode',
    'weekly_reset_vm_id',
    'weekly_window_start',
    'weekly_window_end',
    'weekly_source_account',
  ])
    db.exec(`ALTER TABLE custom_subscription_plans DROP COLUMN ${column}`)
  db.prepare("DELETE FROM custom_schema_migrations WHERE version='005'").run()
  const before = subscriptionSnapshot(db)
  applyCustomMigrations(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  assert.equal(
    db.prepare('SELECT weekly_reset_mode FROM custom_subscription_plans WHERE group_id=99').get().weekly_reset_mode,
    'independent',
  )
  db.prepare("UPDATE custom_subscription_plans SET weekly_reset_vm_id='Claude' WHERE group_id=99").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /plans/)
})

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
  db.prepare("UPDATE users SET concurrency=7 WHERE id='a'").run()
  db.prepare(
    "INSERT INTO users(id,email,username,password_hash,role,concurrency) VALUES('admin','admin@example.test','admin','unused','admin',5)",
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
  db.prepare(
    "INSERT INTO usage_logs(id,request_id,user_id,api_key_id,vm_id,created_at,total_cost,actual_cost) VALUES('history','settled','a','key','slot',?,3.125,3.125)",
  ).run(now)
  db.prepare("INSERT INTO proxies(id,name,host,port) VALUES('proxy','old-proxy','192.0.2.1',1080)").run()
  const before = subscriptionSnapshot(db)
  db.close()
  db = createDatabase({ dataDir: dir })
  verifySubscriptionSchema(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  assert.equal(db.prepare("SELECT group_type FROM api_keys WHERE id='key'").get().group_type, 'all')
  db.prepare("UPDATE api_keys SET group_type='openai',allowed_vms='[\"slot\"]' WHERE id='key'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /api_keys/)
  db.prepare("UPDATE api_keys SET group_type='all',allowed_vms='[]' WHERE id='key'").run()
  db.prepare("UPDATE api_keys SET vm_pool_id='pool_abcd1234' WHERE id='key'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /api_keys/)
  db.prepare("UPDATE api_keys SET vm_pool_id=NULL WHERE id='key'").run()
  const limits = new RequestLimitsRepo(db)
  assert.deepEqual({ ...limits.userLimits({ id: 'a' }) }, { concurrency: 7, rpm_limit: 0 })
  assert.deepEqual({ ...limits.userLimits({ id: 'admin' }) }, { concurrency: 0, rpm_limit: 0 })
  db.prepare("UPDATE custom_user_request_limits SET rpm_limit=99 WHERE user_id='a'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /user_limits/)
  db.prepare("UPDATE custom_user_request_limits SET rpm_limit=0 WHERE user_id='a'").run()
  db.prepare('UPDATE custom_subscription_plans SET group_rpm_limit=60 WHERE group_id=9').run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /plans/)
  db.prepare('UPDATE custom_subscription_plans SET group_rpm_limit=0 WHERE group_id=9').run()
  assert.equal(db.prepare("SELECT session_id FROM usage_logs WHERE id='history'").get().session_id, null)
  assert.equal(
    db.prepare("SELECT outbound_session_id FROM usage_logs WHERE id='history'").get().outbound_session_id,
    null,
  )
  db.prepare("UPDATE usage_logs SET outbound_session_id='outbound-changed' WHERE id='history'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /usage_logs/)
  db.prepare("UPDATE usage_logs SET outbound_session_id=NULL WHERE id='history'").run()
  assert.equal(db.prepare("SELECT intercept FROM usage_logs WHERE id='history'").get().intercept, null)
  db.prepare("UPDATE usage_logs SET intercept='changed' WHERE id='history'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /usage_logs/)
  db.prepare("UPDATE usage_logs SET intercept=NULL WHERE id='history'").run()
  assert.equal(db.prepare("SELECT vm_owner_user_id FROM usage_logs WHERE id='history'").get().vm_owner_user_id, null)
  db.prepare("UPDATE usage_logs SET vm_owner_user_id='a' WHERE id='history'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /usage_logs/)
  db.prepare("UPDATE usage_logs SET vm_owner_user_id=NULL WHERE id='history'").run()
  assert.equal(db.prepare("SELECT label FROM proxies WHERE id='proxy'").get().label, null)
  db.prepare("UPDATE proxies SET label='changed' WHERE id='proxy'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /proxies/)
  db.prepare("UPDATE proxies SET label=NULL WHERE id='proxy'").run()
  assert.equal(db.prepare("SELECT geo_v6_ip FROM proxies WHERE id='proxy'").get().geo_v6_ip, null)
  db.prepare("UPDATE proxies SET geo_v6_ip='2001:db8::1' WHERE id='proxy'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /proxies/)
  db.prepare("UPDATE proxies SET geo_v6_ip=NULL WHERE id='proxy'").run()
  db.prepare("UPDATE proxies SET domain_forward=1 WHERE id='proxy'").run()
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /proxies/)
  db.prepare("UPDATE proxies SET domain_forward=0 WHERE id='proxy'").run()
  db.prepare("INSERT INTO vm_pools VALUES('pool_abcd1234','Pool',1,?,?)").run(now, now)
  assert.throws(() => assertSubscriptionSnapshot(before, subscriptionSnapshot(db)), /vm_pools/)
  const withPool = subscriptionSnapshot(db)
  db.prepare("INSERT INTO vm_pool_members VALUES('pool_abcd1234','slot',?)").run(now)
  assert.throws(() => assertSubscriptionSnapshot(withPool, subscriptionSnapshot(db)), /vm_pool_members/)
  db.prepare("DELETE FROM vm_pools WHERE id='pool_abcd1234'").run()
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

test('fresh install applies upstream 027/028/029 alongside the independent custom migration namespace', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-migrations-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  assert.equal(
    db.prepare("SELECT name FROM schema_migrations WHERE version='027'").get().name,
    '027_usage_logs_session_effort.sql',
  )
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version='028'").get().name, '028_proxy_label.sql')
  assert.equal(
    db.prepare("SELECT name FROM schema_migrations WHERE version='029'").get().name,
    '029_usage_logs_outbound_session.sql',
  )
  assert.equal(
    db.prepare("SELECT name FROM custom_schema_migrations WHERE version='001'").get().name,
    '001_subscriptions.sql',
  )
  const upstream = path.join(dir, 'upstream')
  fs.mkdirSync(upstream)
  fs.writeFileSync(path.join(upstream, '999_future.sql'), 'CREATE TABLE future_upstream(id TEXT);')
  applyMigrations(db, { migrationsDir: upstream })
  assert.equal(db.prepare("SELECT name FROM schema_migrations WHERE version='999'").get().name, '999_future.sql')
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
  assert.equal(
    db.prepare("SELECT name FROM schema_migrations WHERE version='027'").get().name,
    '027_usage_logs_session_effort.sql',
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_schema_migrations').get().n, 6)
  assert.equal(db.prepare('SELECT action FROM custom_subscription_events').get().action, 'sentinel')
})

test('modified legacy migration fails closed and retains the legacy stamp', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reject-subscriptions-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  db.prepare("UPDATE schema_migrations SET name='027_subscriptions.sql',checksum='invalid' WHERE version='027'").run()
  assert.throws(() => applyMigrations(db), /checksum mismatch/)
  assert.equal(db.prepare("SELECT checksum FROM schema_migrations WHERE version='027'").get().checksum, 'invalid')
})
