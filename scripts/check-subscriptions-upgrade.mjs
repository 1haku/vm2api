import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/lib/db/database.mjs'
import {
  subscriptionSnapshot,
  assertSubscriptionSnapshot,
  verifySubscriptionSchema,
} from '../src/lib/db/subscription-snapshot.mjs'

const file = process.argv[2]
if (!file) throw new Error('Usage: node scripts/check-subscriptions-upgrade.mjs <database-copy>')
const original = new DatabaseSync(file, { readOnly: true })
const before = subscriptionSnapshot(original)
original.close()
const db = createDatabase({ dbPath: file })
try {
  verifySubscriptionSchema(db)
  assertSubscriptionSnapshot(before, subscriptionSnapshot(db))
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'integrity',
        'foreign keys',
        'plan limits',
        'ownership',
        'subscriptions',
        'ledger',
        'pending requests',
        'usage and keys',
      ],
      tables: before,
    }),
  )
} finally {
  db.close()
}
