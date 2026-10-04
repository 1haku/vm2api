import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../src/lib/db/database.mjs'
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export function legacySubscriptionDatabase(dir, { v1 = false } = {}) {
  const migrationsDir = path.join(dir, 'upstream-sql')
  fs.mkdirSync(migrationsDir)
  for (const file of fs.readdirSync(path.join(root, 'src/lib/db/migrations'))) {
    // v1/v3 fixtures predate upstream 027/028; their 027 stamp was the old custom subscription SQL.
    if (Number(file.slice(0, 3)) >= 27) continue
    fs.copyFileSync(path.join(root, 'src/lib/db/migrations', file), path.join(migrationsDir, file))
  }
  const db = createDatabase({ dataDir: dir, migrationsDir })
  const sql = fs
    .readFileSync(path.join(root, 'src/lib/db/custom-migrations/001_subscriptions.sql'), 'utf8')
    .replace(/\r\n/g, '\n')
  db.exec(sql)
  const hash = crypto.createHash('sha256').update(sql).digest('hex')
  if (v1)
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(
      '027',
      '027_subscriptions.sql',
      hash,
      '2026-10-01T00:00:00.000Z',
    )
  else {
    db.exec(
      'CREATE TABLE custom_schema_migrations(version TEXT PRIMARY KEY,name TEXT NOT NULL,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)',
    )
    db.prepare('INSERT INTO custom_schema_migrations VALUES(?,?,?,?)').run(
      '001',
      '001_subscriptions.sql',
      hash,
      '2026-10-01T00:00:00.000Z',
    )
  }
  return db
}
