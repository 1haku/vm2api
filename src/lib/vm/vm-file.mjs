/**
 * Safe vm.json / slot-file writes (T7).
 *
 * - atomicWriteJson: write to a temp file in the same dir then rename, so a
 *   concurrent reader (or a crash mid-write) never sees a torn/partial file.
 * - withVmLock: per-path async mutex to serialize read-modify-write sequences
 *   that span `await` boundaries (e.g. the admin sessionKey import path).
 * - writeJsonIfChanged: skip the write entirely when the on-disk content is
 *   byte-identical, cutting per-request write amplification.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * Names inside `vms/` that are not slot records: `active.json` is the active
 * pointer, `<id>-chat.json` is a test-chat side file, and `create`/`import`
 * collide with the `/api/panel/vms/:id` route segments.
 */
const RESERVED_VM_IDS = new Set(['active', 'create', 'create-options', 'import', 'package'])

/** True when `id` must not be used for a slot record. */
export function isReservedVmId(id) {
  const s = String(id || '').toLowerCase()
  return !s || RESERVED_VM_IDS.has(s) || s.endsWith('-chat')
}

/** Slot ids are filename-safe (`[A-Za-z0-9_-]`) and never a reserved name. */
export function isValidVmId(id) {
  return /^[A-Za-z0-9_-]+$/.test(String(id || '')) && !isReservedVmId(id)
}

/** True for a `vms/<id>.json` slot record — any id, not just `vm-` prefixed. */
export function isVmRecordFile(base) {
  const name = String(base || '')
  if (!name.endsWith('.json') || name.startsWith('.')) return false
  return !isReservedVmId(name.slice(0, -5))
}

/** Slot record file names inside `dir` (missing/unreadable dir → `[]`). */
export function listVmRecordFiles(dir) {
  try {
    return fs.readdirSync(dir).filter(isVmRecordFile)
  } catch {
    return []
  }
}

/* --------------------------------------------------------------------------
 * Slot-record read cache (local patch: perf).
 *
 * A scheduling attempt reads every slot record, and the pool re-runs the
 * attempt on every request, retry and failover. With ~100 slots that is
 * thousands of readFileSync + UTF-8 decode calls per second, which saturates
 * the single Node thread and starves the admin API. The cache is keyed by
 * (mtime, size, inode), so the text handed out is always the bytes on disk at
 * call time: a record replaced by an atomic rename, or touched by a slot
 * worker, changes the key and is re-read on the next call. Only file text is
 * cached (never a parsed object), so callers still own their own copy.
 *
 * `KIN_VM_READ_CACHE_MS=0` disables the cache entirely (escape hatch).
 * ------------------------------------------------------------------------ */
const readCache = new Map()

const readCacheEnabled = (() => {
  const raw = process.env.KIN_VM_READ_CACHE_MS
  if (raw == null || raw === '') return true
  const value = Number(raw)
  return Number.isFinite(value) ? value > 0 : true
})()

/** File text for `file`, re-read only when the on-disk identity changed. */
export function readFileCached(file) {
  if (!readCacheEnabled) {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch {
    readCache.delete(file)
    return null
  }
  const hit = readCache.get(file)
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.ino === stat.ino) {
    return hit.text
  }
  let text = null
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    readCache.delete(file)
    return null
  }
  readCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, text })
  return text
}

/** Parsed JSON for `file`, or null when the file is missing / not JSON. */
export function readJsonCached(file) {
  const text = readFileCached(file)
  if (text == null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Drop one path (or the whole cache) — called from every writer in this file. */
export function invalidateReadCache(file = null) {
  if (file) readCache.delete(file)
  else readCache.clear()
}

/** Cache size, for the panel / diagnostics. */
export function readCacheSize() {
  return readCache.size
}

const locks = new Map()

/**
 * Optional post-write hook (installed by lib/vm-db-sync.mjs) so every
 * vm.json write is mirrored into the SQLite `vms` table. Kept as a
 * registration seam to avoid an import cycle and to keep unit tests
 * (no DB) behavior-identical.
 */
let vmWriteHook = null
export function setVmWriteHook(fn) {
  vmWriteHook = typeof fn === 'function' ? fn : null
}

function notifyVmWrite(filePath) {
  if (!vmWriteHook) return
  try {
    vmWriteHook(filePath)
  } catch {}
}

export function withVmLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  // Keep the chain alive but never reject the stored promise.
  locks.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

export function atomicWriteJson(filePath, obj, { mode } = {}) {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`)
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  const opts = mode ? { mode } : undefined
  fs.writeFileSync(tmp, data, opts)
  try {
    fs.renameSync(tmp, filePath)
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {}
    throw e
  }
  if (mode) {
    try {
      fs.chmodSync(filePath, mode)
    } catch {}
  }
  invalidateReadCache(filePath)
  notifyVmWrite(filePath)
  return true
}

export function writeJsonIfChanged(filePath, obj, { mode } = {}) {
  const data = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  try {
    if (fs.existsSync(filePath) && readFileCached(filePath) === data) {
      return false
    }
  } catch {}
  atomicWriteJson(filePath, data, { mode })
  return true
}
