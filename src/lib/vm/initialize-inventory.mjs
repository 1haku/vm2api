import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { atomicWriteJson, isValidVmId, listVmRecordFiles } from './vm-file.mjs'

// Bootstrap a new installation, never fill holes in an existing slot inventory.
export function initializeSlotInventory(projectRoot, dbPath = path.join(projectRoot, 'data', 'kin.db')) {
  const dir = path.join(projectRoot, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  const activeFile = path.join(dir, 'active.json')
  const hasActive = fs.existsSync(activeFile)
  // A malformed pointer is a configuration error, not permission to overwrite it.
  const active = hasActive ? JSON.parse(fs.readFileSync(activeFile, 'utf8')) : null
  const files = listVmRecordFiles(dir).sort()
  const ids = files.flatMap((file) => {
    const id = file.slice(0, -5)
    if (!isValidVmId(id)) return []
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      return record?.id === id ? [id] : []
    } catch {
      return []
    }
  })
  if (ids.includes(active?.active_vm)) return { action: 'preserved', id: active.active_vm }
  if (ids.length) {
    const id = ids[0]
    atomicWriteJson(activeFile, { active_vm: id, updated_at: new Date().toISOString() })
    return { action: 'restored-pointer', id }
  }
  let databaseHasSlots = false
  if (fs.existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      // A valid initialized database with no slots is legitimate after deletion.
      // Missing schema or a corrupt file must not be mistaken for an empty fleet.
      databaseHasSlots = !!db.prepare('SELECT 1 FROM vms LIMIT 1').get()
    } finally {
      db.close()
    }
  }
  if (hasActive || files.length || databaseHasSlots) {
    throw new Error(
      'Existing installation has no valid slot record; restore its inventory before starting. No default slot was created.',
    )
  }
  return { action: 'empty', id: null }
}
