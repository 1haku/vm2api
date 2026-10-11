import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { reloadActiveVm } from '../../src/lib/core/config.mjs'
import { openDatabase, closeDatabase, getDb } from '../../src/lib/db/database.mjs'
import { initializeSlotInventory } from '../../src/lib/vm/initialize-inventory.mjs'

function seed(root, id, { active = false } = {}) {
  const dir = path.join(root, 'vms')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({ id, name: id, status: 'stopped', schedulable: false, policy: { maxConcurrency: 2 } }),
  )
  if (active) fs.writeFileSync(path.join(dir, 'active.json'), JSON.stringify({ active_vm: id }))
}

function handler(project) {
  openDatabase({ dataDir: path.join(project, 'data') })
  const response = {}
  const cfg = { paths: { project }, vm: { id: 'stale' } }
  const handlePanel = createPanelHandler({
    cfg,
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    json(_res, status, payload) {
      response.status = status
      response.body = payload
      return true
    },
    readBody: async () => ({}),
    proxyPool: { unbindVm() {} },
  })
  return { handlePanel, response, cfg }
}

test.afterEach(() => closeDatabase())

test('a sole active slot bound to a subscription cannot be deleted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-subscription-'))
  try {
    seed(root, 'vm-01', { active: true })
    const { handlePanel, response } = handler(root)
    getDb().prepare('INSERT INTO custom_subscription_slots(group_id,vm_id) VALUES(1,?)').run('vm-01')
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 409)
    assert.match(response.body.error.message, /订阅/)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), true)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('fresh deploy can delete its only active VM', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-only-'))
  try {
    seed(root, 'vm-01', { active: true })
    const { handlePanel, response, cfg } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body?.data?.deleted, 'vm-01')
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'active.json')), false)
    reloadActiveVm(cfg)
    assert.equal(cfg.vm.id, null)
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('active VM stays when another slot exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-active-'))
  try {
    seed(root, 'vm-01', { active: true })
    seed(root, 'vm-02')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 409)
    assert.match(response.body?.error?.message, /switch active first/)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8')).active_vm, 'vm-01')
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('non-active VM deletes while the active pointer stays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-other-'))
  try {
    seed(root, 'vm-01', { active: true })
    seed(root, 'vm-02')
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-02'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-02.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), true)
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'vms', 'active.json'), 'utf8')).active_vm, 'vm-01')
  } finally {
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('startup reconcile does not resurrect a deleted sole active VM', async () => {
  const { openDatabase, closeDatabase } = await import('../../src/lib/db/database.mjs')
  const { initVmDbSync, stopVmWatch, reconcileVms } = await import('../../src/lib/vm/vm-db-sync.mjs')
  const { setVmWriteHook } = await import('../../src/lib/vm/vm-file.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-del-db-'))
  try {
    openDatabase({ dataDir: path.join(root, 'data') })
    seed(root, 'vm-01', { active: true })
    initVmDbSync(root, { watch: false })
    const { handlePanel, response } = handler(root)
    await handlePanel({ method: 'DELETE' }, {}, new URL('http://localhost/api/panel/vms/vm-01'))
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const again = reconcileVms(root)
    assert.equal(again.rebuilt, 0)
    assert.equal(again.active, null)
    assert.deepEqual(initializeSlotInventory(root), { action: 'empty', id: null })
    assert.equal(fs.existsSync(path.join(root, 'vms', 'vm-01.json')), false)
    assert.equal(fs.existsSync(path.join(root, 'vms', 'active.json')), false)
  } finally {
    stopVmWatch()
    setVmWriteHook(null)
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
