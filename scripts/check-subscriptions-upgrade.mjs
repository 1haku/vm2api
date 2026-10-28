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
        '037 historical input normalization only; costs and ownership unchanged',
        '040/041 Linux node default and nullable inbound device only; existing data unchanged',
        '043/044/046 nullable timing and audit fields only; historical values stay unknown',
        '047 upstream service tier is nullable; historical prices and sent tiers are preserved',
      ],
      tables: before,
    }),
  )
} finally {
  db.close()
}
