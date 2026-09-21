/**
 * refusal_guards — persisted AUP fingerprints. Lookup before hop; remember after refusal.
 */
import { getDb } from '../database.mjs'

function rowToRec(row) {
  if (!row) return null
  return {
    fingerprint: row.fingerprint,
    model: row.model,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    hit_count: Number(row.hit_count) || 0,
    source_request_id: row.source_request_id,
    error_message: row.error_message,
    preview: row.preview,
    expires_at: row.expires_at || null,
  }
}

export class RefusalGuardsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._get = db.prepare('SELECT * FROM refusal_guards WHERE fingerprint = ?')
    this._insert = db.prepare(`
      INSERT INTO refusal_guards (
        fingerprint, model, first_seen_at, last_seen_at, hit_count,
        source_request_id, error_message, preview, expires_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        error_message = COALESCE(excluded.error_message, refusal_guards.error_message),
        preview = COALESCE(excluded.preview, refusal_guards.preview),
        expires_at = CASE
          WHEN refusal_guards.expires_at IS NULL THEN NULL
          WHEN excluded.expires_at IS NULL THEN NULL
          ELSE excluded.expires_at
        END
    `)
    this._hit = db.prepare(`
      UPDATE refusal_guards SET hit_count = hit_count + 1, last_seen_at = ?
      WHERE fingerprint = ?
    `)
    this._list = db.prepare('SELECT * FROM refusal_guards ORDER BY last_seen_at DESC, fingerprint LIMIT ?')
    this._count = db.prepare('SELECT COUNT(*) AS n FROM refusal_guards')
    this._remove = db.prepare('DELETE FROM refusal_guards WHERE fingerprint = ?')
    this._clear = db.prepare('DELETE FROM refusal_guards')
  }

  get(fingerprint) {
    const rec = rowToRec(this._get.get(String(fingerprint || '')))
    if (!rec?.expires_at) return rec
    if (Date.parse(rec.expires_at) > Date.now()) return rec
    this.remove(rec.fingerprint)
    return null
  }

  remember({ fingerprint, model = '', requestId = null, errorMessage = null, preview = null, expiresAt = null } = {}) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return null
    const now = new Date().toISOString()
    this._insert.run(
      fp,
      String(model || ''),
      now,
      now,
      requestId,
      errorMessage ? String(errorMessage).slice(0, 500) : null,
      preview ? String(preview).slice(0, 240) : null,
      expiresAt || null,
    )
    return this.get(fp)
  }

  hit(fingerprint) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return null
    this._hit.run(new Date().toISOString(), fp)
    return this.get(fp)
  }

  list(limit = 200) {
    const n = Math.min(500, Math.max(1, Number(limit) || 200))
    const now = Date.now()
    return this._list
      .all(n)
      .map(rowToRec)
      .filter((rec) => !rec.expires_at || Date.parse(rec.expires_at) > now)
  }

  count() {
    return Number(this._count.get()?.n) || 0
  }

  remove(fingerprint) {
    const fp = String(fingerprint || '').trim()
    if (!fp) return false
    return this._remove.run(fp).changes > 0
  }

  clear() {
    return this._clear.run().changes
  }
}
