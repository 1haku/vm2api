import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernelWatchdog, isKernelWatchdogTarget } from '../../src/lib/transport/kernel-watchdog.mjs'

test('watchdog skips stopped slots; stored go is treated as rust', () => {
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01' }), false)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', inference_engine: 'rust' }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', runtime: { engine: 'rust' } }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', inference_engine: 'go' }), true)
  assert.equal(isKernelWatchdogTarget({ id: 'vm-01', status: 'stopped' }), false)
})

test('watchdog ensure is called only when rust is unreachable', async () => {
  const ensured = []
  const wd = createKernelWatchdog({
    listTargets: () => [
      { id: 'vm-up', inference_engine: 'rust' },
      { id: 'vm-busy', inference_engine: 'rust' },
      { id: 'vm-down', inference_engine: 'rust' },
      { id: 'vm-go', inference_engine: 'go' },
    ],
    homeDirFor: (vm) => `/tmp/${vm.id}`,
    health: async (exec) => {
      if (exec.vmId === 'vm-up') return { ok: true, ready_slots: 1, cli_pid: 1 }
      if (exec.vmId === 'vm-busy') return { ok: true, ready_slots: 0, cli_pid: 9 }
      return { ok: false, ready_slots: 0 }
    },
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
  })
  await wd.tick()
  assert.deepEqual(ensured, ['vm-down', 'vm-go'])
})

test('watchdog does not restart a live crag slot', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wd-crag-'))
  const home = path.join(root, 'vms', 'vm-crag', 'cli-home')
  const run = path.join(root, 'vms', 'vm-crag', 'run')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(run, { recursive: true })
  fs.writeFileSync(path.join(run, 'kernel.json'), JSON.stringify({ dataplane: 'crag' }))
  const ensured = []
  const wd = createKernelWatchdog({
    listTargets: () => [{ id: 'vm-crag', inference_engine: 'rust' }],
    homeDirFor: () => home,
    health: async () => ({ ok: true, engine: 'rust', ready_slots: 0, cli_pid: 0 }),
    ensure: async (exec) => {
      ensured.push(exec.vmId)
      return { ok: true }
    },
  })
  await wd.tick()
  assert.deepEqual(ensured, [])
  fs.rmSync(root, { recursive: true, force: true })
})
