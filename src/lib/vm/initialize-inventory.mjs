import fs from 'node:fs'
import path from 'node:path'
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
  if (hasActive || files.length || fs.existsSync(dbPath)) {
    throw new Error(
      'Existing installation has no valid slot record; restore its inventory before starting. No default slot was created.',
    )
  }
  const id = 'vm-01'
  atomicWriteJson(path.join(dir, `${id}.json`), {
    id,
    name: id,
    status: 'stopped',
    schedulable: false,
    policy: { maxConcurrency: 2 },
  })
  atomicWriteJson(activeFile, { active_vm: id })
  return { action: 'initialized', id }
}
