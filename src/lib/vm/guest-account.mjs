import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { createDatabase, getDb, isDbOpen, withTransaction } from '../db/database.mjs'
import { guestContractError } from './os-catalog.mjs'

const USERNAME = /^[a-z][a-z0-9_]{2,23}$/
export const GUEST_ACCOUNT_V2 = 'linux-account-v2'

export function validateGuestUsername(username) {
  if (typeof username !== 'string' || !USERNAME.test(username)) {
    throw guestContractError(
      'guest_user_conflict',
      'Guest username must be 3–24 lowercase letters, digits or underscores and start with a letter',
    )
  }
  return username
}

export function guestAccount(vm) {
  const account = vm?.guest_user
  if (account != null) {
    if (account.contract !== GUEST_ACCOUNT_V2)
      throw guestContractError('guest_user_conflict', 'Unknown guest account contract')
    validateGuestUsername(account.username)
    if (
      ![account.uid, account.gid].every((id) => Number.isSafeInteger(id) && id >= 10000 && id <= 60000) ||
      account.home !== `/home/${account.username}`
    ) {
      throw guestContractError(
        'guest_user_conflict',
        'Guest account numeric identity or home does not match its contract',
      )
    }
    return {
      contract: GUEST_ACCOUNT_V2,
      username: account.username,
      uid: account.uid,
      gid: account.gid,
      home: account.home,
    }
  }
  const parse = (value) => {
    const raw = String(value || '')
    const match = raw.match(/^vm-(\d+)$/i) || raw.match(/^0*(\d+)$/)
    return match ? Number(match[1]) || 1 : null
  }
  const index = parse(vm?.id) ?? parse(vm?.name) ?? 1
  return {
    contract: 'legacy',
    username: 'kincli',
    home: '/home/kincli',
    uid: Number(process.env.KIN_VM_UID_BASE || 10000) + index,
    gid: Number(process.env.KIN_VM_GID || 987),
  }
}

function withAccountDb(projectRoot, fn) {
  const owned = !isDbOpen()
  const db = owned ? createDatabase({ dataDir: path.join(projectRoot, 'data') }) : getDb()
  try {
    return fn(db, path.resolve(projectRoot))
  } finally {
    if (owned) db.close()
  }
}

export function findGuestAllocation(projectRoot, operationId) {
  return withAccountDb(projectRoot, (db, project) => {
    const row = db
      .prepare('SELECT raw FROM guest_accounts WHERE project = ? AND operation_id = ?')
      .get(project, operationId)
    return row ? JSON.parse(row.raw) : null
  })
}

function legacyUidInUse(projectRoot, uid) {
  const directory = path.join(projectRoot, 'vms')
  if (!fs.existsSync(directory)) return false
  for (const file of fs.readdirSync(directory)) {
    if (!/^[a-zA-Z0-9_-]{1,80}\.json$/.test(file) || file === 'active.json') continue
    const record = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))
    if (record.id === file.slice(0, -5) && !record.guest_user && guestAccount(record).uid === uid) return true
  }
  return false
}

export function withLegacyGuestUidLock(projectRoot, vm, publish) {
  const uid = guestAccount(vm).uid
  return withAccountDb(projectRoot, (db, project) =>
    withTransaction(db, () => {
      db.prepare('UPDATE guest_accounts SET raw = raw WHERE project = ? AND uid = ?').run(project, uid)
      if (db.prepare('SELECT 1 FROM guest_accounts WHERE project = ? AND uid = ?').get(project, uid)) {
        throw guestContractError('guest_user_conflict', 'Legacy execution UID is reserved by a guest account', 409)
      }
      return publish()
    }),
  )
}

export function allocateGuestAccount(projectRoot, vmId, { username, operationId, specHash, legacyUids = [] } = {}) {
  if (username != null) validateGuestUsername(username)
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(vmId || '') ||
    typeof operationId !== 'string' ||
    !operationId ||
    typeof specHash !== 'string' ||
    !specHash
  )
    throw guestContractError('guest_user_conflict', 'Guest allocation requires a VM, operation and spec hash')
  const reserved = new Set(legacyUids)
  return withAccountDb(projectRoot, (db, project) => {
    const insert = db.prepare(`INSERT OR IGNORE INTO guest_accounts
      (project, vm_id, operation_id, spec_hash, username, uid, hostname, uuid, mac, machine_id, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const existing = db.prepare('SELECT raw FROM guest_accounts WHERE project = ? AND (vm_id = ? OR operation_id = ?)')
    for (let attempt = 0; attempt < 64; attempt++) {
      const suffix = crypto.randomBytes(6).toString('hex')
      const uid = crypto.randomInt(20000, 60000)
      if (reserved.has(uid)) continue
      const mac = crypto.randomBytes(6)
      mac[0] = (mac[0] | 2) & 0xfe
      const name = username || `guest_${suffix}`
      const account = {
        contract: GUEST_ACCOUNT_V2,
        vm_id: vmId,
        username: name,
        uid,
        gid: uid,
        home: `/home/${name}`,
        hostname: `guest-${suffix}`,
        uuid: crypto.randomUUID(),
        mac: [...mac].map((b) => b.toString(16).padStart(2, '0')).join(':'),
        machine_id: crypto.randomBytes(16).toString('hex'),
        operation_id: operationId,
        spec_hash: specHash,
      }
      const result = withTransaction(db, () => {
        // The first statement is a write: concurrent processes serialize before reading a reservation.
        const inserted = insert.run(
          project,
          vmId,
          operationId,
          specHash,
          name,
          uid,
          account.hostname,
          account.uuid,
          account.mac,
          account.machine_id,
          JSON.stringify(account),
        )
        if (inserted.changes && legacyUidInUse(projectRoot, uid)) {
          db.prepare('DELETE FROM guest_accounts WHERE project = ? AND vm_id = ?').run(project, vmId)
          return null
        }
        const row = existing.get(project, vmId, operationId)
        if (row) {
          const saved = JSON.parse(row.raw)
          if (saved.retired) throw guestContractError('idempotency_conflict', 'Guest operation has been retired', 409)
          if (
            saved.operation_id !== operationId ||
            saved.spec_hash !== specHash ||
            (username && saved.username !== username)
          ) {
            throw guestContractError(
              'idempotency_conflict',
              'Guest operation or specification conflicts with its existing allocation',
              409,
            )
          }
          return saved
        }
        if (
          username &&
          db.prepare('SELECT 1 FROM guest_accounts WHERE project = ? AND username = ?').get(project, username)
        ) {
          throw guestContractError('guest_user_conflict', 'Guest username is already reserved', 409)
        }
        if (inserted.changes) throw new Error('guest allocation was inserted but cannot be read')
        return null
      })
      if (result) return result
    }
    throw guestContractError('guest_user_conflict', 'No unique guest identity could be allocated', 409)
  })
}

export function guestBins(vm) {
  const home = guestAccount(vm).home
  return {
    home,
    cliNode: `${home}/.kin/cli-node`,
    ccNode: `${home}/.kin/cc-node`,
    kernel: `${home}/.kin/kin-kernel`,
    credentials: `${home}/.claude/credentials.json`,
  }
}

export function guestAccountForId(vmId, projectRoot) {
  if (!projectRoot) return guestAccount({ id: vmId })
  if (typeof vmId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(vmId))
    throw guestContractError('guest_user_conflict', 'Invalid guest VM identifier')
  const file = path.join(projectRoot, 'vms', `${vmId}.json`)
  return guestAccount(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id: vmId })
}

export function withGuestAccountLock(projectRoot, vmId, fn) {
  return withAccountDb(projectRoot, (db, project) =>
    withTransaction(db, () => {
      // A first write acquires SQLite's process-wide writer lock before touching instance files.
      const row = db
        .prepare('UPDATE guest_accounts SET raw = raw WHERE project = ? AND vm_id = ? RETURNING raw')
        .get(project, vmId)
      if (!row) throw guestContractError('guest_user_conflict', 'Guest has no persistent account reservation', 409)
      return fn(JSON.parse(row.raw))
    }),
  )
}

export function retireGuestAllocation(projectRoot, vm) {
  if (guestAccount(vm).contract !== GUEST_ACCOUNT_V2) return null
  return withAccountDb(projectRoot, (db, project) =>
    withTransaction(db, () => {
      const row = db
        .prepare('UPDATE guest_accounts SET raw = raw WHERE project = ? AND vm_id = ? RETURNING raw')
        .get(project, vm.id)
      if (!row) throw guestContractError('guest_user_conflict', 'Guest has no persistent account reservation', 409)
      const allocation = JSON.parse(row.raw)
      if (allocation.retired)
        throw guestContractError('guest_probe_stale', 'Guest is already being deleted or reset', 409)
      const token = crypto.randomUUID()
      allocation.retired = token
      db.prepare('UPDATE guest_accounts SET raw = ? WHERE project = ? AND vm_id = ?').run(
        JSON.stringify(allocation),
        project,
        vm.id,
      )
      return token
    }),
  )
}

export function resumeGuestAllocation(projectRoot, vm, token) {
  if (!token) return
  return withAccountDb(projectRoot, (db, project) =>
    withTransaction(db, () => {
      const row = db
        .prepare('UPDATE guest_accounts SET raw = raw WHERE project = ? AND vm_id = ? RETURNING raw')
        .get(project, vm.id)
      if (!row) return
      const allocation = JSON.parse(row.raw)
      if (allocation.retired !== token) return
      delete allocation.retired
      db.prepare('UPDATE guest_accounts SET raw = ? WHERE project = ? AND vm_id = ?').run(
        JSON.stringify(allocation),
        project,
        vm.id,
      )
    }),
  )
}

export function guestAccountForHomeDir(homeDir) {
  const normalized = String(homeDir || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
  if (path.basename(normalized) !== 'cli-home') return null
  const vmId = path.basename(path.dirname(normalized))
  return guestAccountForId(vmId, path.dirname(path.dirname(path.dirname(normalized))))
}
