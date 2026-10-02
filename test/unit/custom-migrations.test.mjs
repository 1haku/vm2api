import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, applyMigrations } from '../../src/lib/db/database.mjs'

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
  let db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const row = db.prepare('SELECT * FROM custom_schema_migrations').get()
  db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(
    '027',
    '027_subscriptions.sql',
    row.checksum,
    row.applied_at,
  )
  db.exec('DELETE FROM custom_schema_migrations')
  db.prepare('INSERT INTO subscription_events(action,detail,created_at) VALUES(?,?,?)').run(
    'sentinel',
    '{}',
    new Date().toISOString(),
  )
  db.close()
  db = createDatabase({ dataDir: dir })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version='027'").get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_schema_migrations').get().n, 1)
  assert.equal(db.prepare('SELECT action FROM subscription_events').get().action, 'sentinel')
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
