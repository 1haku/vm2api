import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { StatisticsRepo } from '../../src/lib/db/repos/statistics-repo.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

test('cancelled requests preserve traffic and billing totals but do not dilute SLA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancelled-sla-'))
  const db = createDatabase({ dataDir: dir })
  try {
    const repo = new UsageLogsRepo(db)
    const now = Date.now(),
      ts = new Date(now - 1000).toISOString()
    for (const [id, status, final_state] of [
      ['ok', 200, 'verified'],
      ['cancel', 499, 'cancelled'],
    ]) {
      repo.insertSummaryIfAbsent({
        id,
        request_id: id,
        ts,
        status,
        final_state,
        model: 'test',
        total_cost: 1,
        actual_cost: 1,
      })
    }
    const stats = repo.windowStats()
    assert.equal(stats.requests, 2)
    assert.equal(stats.total_cost, 2)
    assert.equal(stats.sla, 1)
    assert.equal(stats.errors, 0)
    const board = new StatisticsRepo(db).leaderboard({ range: 'today', scope: 'model', tz: 'UTC', now })
    assert.equal(board.entries[0].successRate, 1)
    assert.equal(board.entries[0].totalRequests, 2)
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
