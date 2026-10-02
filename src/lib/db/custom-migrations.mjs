import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'custom-migrations')
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex')
function checks(sql) {
  const lf = sql.replace(/\r\n/g, '\n')
  return { canonical: hash(lf), accepted: new Set([hash(sql), hash(lf), hash(lf.replace(/\n/g, '\r\n'))]) }
}
function table(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS custom_schema_migrations(version TEXT PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)',
  )
}

// Adopt only this fork's exact published migration. Never rewrite an upstream 027.
export function adoptLegacySubscriptions(db) {
  table(db)
  const legacy = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get('027')
  if (!legacy || legacy.name !== '027_subscriptions.sql') return
  const expected = checks(fs.readFileSync(path.join(DIR, '001_subscriptions.sql'), 'utf8'))
  if (!expected.accepted.has(legacy.checksum))
    throw new Error('Legacy subscription migration checksum mismatch; restore or inspect before upgrading')
  const present = db.prepare('SELECT * FROM custom_schema_migrations WHERE version=?').get('001')
  if (present && !expected.accepted.has(present.checksum))
    throw new Error('Custom subscription migration checksum mismatch')
  db.exec('BEGIN')
  try {
    db.prepare('INSERT OR IGNORE INTO custom_schema_migrations VALUES(?,?,?,?)').run(
      '001',
      '001_subscriptions.sql',
      expected.canonical,
      legacy.applied_at,
    )
    db.prepare('DELETE FROM schema_migrations WHERE version=? AND name=?').run('027', '027_subscriptions.sql')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export function applyCustomMigrations(db) {
  table(db)
  const results = []
  for (const file of fs
    .readdirSync(DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()) {
    const version = file.split('_')[0]
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8')
    const expected = checks(sql)
    const old = db.prepare('SELECT checksum FROM custom_schema_migrations WHERE version=?').get(version)
    if (old) {
      if (!expected.accepted.has(old.checksum)) throw new Error(`Custom migration checksum mismatch: ${file}`)
      continue
    }
    db.exec('BEGIN')
    try {
      db.exec(sql)
      db.prepare('INSERT INTO custom_schema_migrations VALUES(?,?,?,?)').run(
        version,
        file,
        expected.canonical,
        new Date().toISOString(),
      )
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`Custom migration ${file} failed: ${e.message}`)
    }
    results.push(`custom/${file}`)
  }
  return results
}
