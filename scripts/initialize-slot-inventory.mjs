import path from 'node:path'
import { initializeSlotInventory } from '../src/lib/vm/initialize-inventory.mjs'

const root = process.argv[2] || process.env.KIN_PROJECT_ROOT || '/opt/vm2api'
try {
  const dbPath = process.env.KIN_DB_PATH || path.join(process.env.KIN_DATA_DIR || path.join(root, 'data'), 'kin.db')
  const result = initializeSlotInventory(root, dbPath)
  if (result.action !== 'preserved') console.log(`Slot inventory: ${result.action} (${result.id})`)
} catch (error) {
  console.error(`Slot inventory: ${error.message}`)
  process.exitCode = 1
}
