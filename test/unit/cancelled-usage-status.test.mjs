import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { isErrorRow } from '../../src/lib/admin/error-class.mjs'
import { ERROR_PRED, SUCCESS_PRED, SLA_ERROR_PRED, SLA_SUCCESS_PRED } from '../../src/lib/db/repos/usage-log-preds.mjs'

test('local cancelled 499 remains visible without counting as a provider failure or successful reply', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE usage_logs (status INTEGER, final_state TEXT, error_code TEXT)')
    db.exec(
      "INSERT INTO usage_logs VALUES (499, 'cancelled', NULL), (503, 'exhausted', 'unavailable'), (200, 'verified', NULL)",
    )
    const rows = db
      .prepare(
        `SELECT status, ${ERROR_PRED} AS error, ${SUCCESS_PRED} AS success, ${SLA_ERROR_PRED} AS sla_error, ${SLA_SUCCESS_PRED} AS sla_success FROM usage_logs ORDER BY status`,
      )
      .all()
    assert.deepEqual(
      rows.map((r) => [r.status, r.error, r.success, r.sla_error, r.sla_success]),
      [
        [200, 0, 1, 0, 1],
        [499, 0, 0, 0, 0],
        [503, 1, 0, 1, 0],
      ],
    )
    assert.equal(isErrorRow({ status: 499, final_state: 'cancelled' }), false)
    assert.equal(isErrorRow({ status: 503, final_state: 'cancelled' }), true)
  } finally {
    db.close()
  }
})
