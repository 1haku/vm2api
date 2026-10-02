import fs from 'node:fs'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { verifySubscriptionSchema } from '../src/lib/db/subscription-snapshot.mjs'
const manifest = JSON.parse(fs.readFileSync('release-manifest.json', 'utf8'))
assert.equal(manifest.revision, process.argv[2])
assert.equal(process.env.VM2API_CUSTOM_BUILD, 'subscriptions-v4')
for (const [file, expected] of Object.entries(manifest.files)) {
  const actual = file.startsWith('image-bin/') ? file.replace('image-bin/', 'bin/') : file
  assert.equal(
    crypto.createHash('sha256').update(fs.readFileSync(actual)).digest('hex'),
    expected,
    `release file mismatch: ${actual}`,
  )
}
const db = new DatabaseSync(process.env.KIN_DB_PATH || '/opt/vm2api/data/kin.db', { readOnly: true })
verifySubscriptionSchema(db)
db.close()
console.log(
  JSON.stringify({
    ok: true,
    revision: manifest.revision,
    version: manifest.upstreamVersion,
    files: Object.keys(manifest.files).length,
    checks: ['database schema', 'deployed binaries', 'console assets', 'dependency lockfile'],
  }),
)
