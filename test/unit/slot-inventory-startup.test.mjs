import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { initializeSlotInventory } from '../../src/lib/vm/initialize-inventory.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-inventory-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir)
  return {
    root,
    write: (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value)),
    read: (name) => fs.readFileSync(path.join(dir, name), 'utf8'),
    hasDefault: () => fs.existsSync(path.join(dir, 'vm-01.json')),
  }
}

test('fresh installation initializes the legacy default once', (t) => {
  const f = fixture(t)
  assert.deepEqual(initializeSlotInventory(f.root), { action: 'initialized', id: 'vm-01' })
  assert.equal(JSON.parse(f.read('vm-01.json')).schedulable, false)
  const original = f.read('vm-01.json')
  assert.equal(initializeSlotInventory(f.root).action, 'preserved')
  assert.equal(f.read('vm-01.json'), original)
})

test('deleted default stays absent across repeated starts; credentials and active pointer stay intact', (t) => {
  const f = fixture(t)
  f.write('Codex.json', { id: 'Codex', codex: { fixtureCredential: 'preserve-me' } })
  f.write('Claude.json', { id: 'Claude' })
  f.write('active.json', { active_vm: 'Codex', updated_at: 'existing-timestamp' })
  const originalActive = f.read('active.json')
  const originalCodex = f.read('Codex.json')
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(initializeSlotInventory(f.root), { action: 'preserved', id: 'Codex' })
    assert.equal(f.hasDefault(), false)
    assert.equal(f.read('active.json'), originalActive)
    assert.equal(f.read('Codex.json'), originalCodex)
  }
})

for (const pointer of [null, { active_vm: 'vm-01' }, { active_vm: '../outside' }]) {
  test(`repairs ${JSON.stringify(pointer)} using existing slots without creating a default`, (t) => {
    const f = fixture(t)
    if (pointer) f.write('active.json', pointer)
    f.write('Codex.json', { id: 'Codex' })
    f.write('Codex-chat.json', { id: 'ignored' })
    assert.deepEqual(initializeSlotInventory(f.root), { action: 'restored-pointer', id: 'Codex' })
    assert.equal(JSON.parse(f.read('active.json')).active_vm, 'Codex')
    assert.equal(f.hasDefault(), false)
  })
}

test('never replaces corrupt or empty existing inventory with a fresh default', (t) => {
  const f = fixture(t)
  f.write('active.json', { active_vm: 'vm-01' })
  assert.throws(() => initializeSlotInventory(f.root), /restore its inventory/)
  f.write('broken.json', { id: 'different-id' })
  assert.throws(() => initializeSlotInventory(f.root), /restore its inventory/)
  assert.equal(f.hasDefault(), false)
})

test('an existing database prevents treating lost slot files as a new installation', (t) => {
  const f = fixture(t)
  const db = path.join(f.root, 'custom.db')
  fs.writeFileSync(db, '')
  assert.throws(() => initializeSlotInventory(f.root, db), /No default slot was created/)
  assert.equal(f.hasDefault(), false)
})

test('malformed active pointer fails without overwriting its contents', (t) => {
  const f = fixture(t)
  f.write('Codex.json', { id: 'Codex' })
  fs.writeFileSync(path.join(f.root, 'vms', 'active.json'), '{')
  assert.throws(() => initializeSlotInventory(f.root), SyntaxError)
  assert.equal(f.read('active.json'), '{')
  assert.equal(f.hasDefault(), false)
})

test('container entrypoint delegates inventory initialization instead of recreating vm-01', () => {
  const script = fs.readFileSync(new URL('../../scripts/docker-entrypoint.sh', import.meta.url), 'utf8')
  assert.match(script, /node \/opt\/vm2api\/scripts\/initialize-slot-inventory\.mjs "\$ROOT"/)
  assert.doesNotMatch(script, /cat > "\$ROOT\/vms\/vm-01\.json"/)
})

test('startup CLI honors a custom data directory and fails without creating a slot', (t) => {
  const f = fixture(t)
  const dataDir = path.join(f.root, 'custom-data')
  fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(dataDir, 'kin.db'), '')
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../../scripts/initialize-slot-inventory.mjs', import.meta.url)), f.root],
    {
      encoding: 'utf8',
      env: { ...process.env, KIN_DB_PATH: '', KIN_DATA_DIR: dataDir },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /No default slot was created/)
  assert.equal(f.hasDefault(), false)
})
