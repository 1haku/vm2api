import test from 'node:test'
import assert from 'node:assert/strict'
import {
  toPublicKernelHealth,
  rustKernelBusy,
  rustKernelReachable,
} from '../../src/lib/transport/rust-kernel-client.mjs'

test('toPublicKernelHealth keeps wrap cli-hop slot fields', () => {
  const out = toPublicKernelHealth(
    {
      ok: true,
      status: 200,
      engine: 'rust',
      provider: 'local_cli',
      worker_version: 'wrap-1',
      ready_slots: 20,
      cli_pid: 4412,
    },
    'rust',
  )
  assert.equal(out.reachable, true)
  assert.equal(out.process_up, true)
  assert.equal(out.provider, 'local_cli')
  assert.equal(out.ready_slots, 20)
  assert.equal(out.cli_pid, 4412)
  assert.equal(out.worker_version, 'wrap-1')
  assert.equal(out.error_code, null)
})

test('toPublicKernelHealth treats kernel-up/zero-slots as not reachable', () => {
  const out = toPublicKernelHealth(
    {
      ok: true,
      status: 200,
      engine: 'rust',
      provider: 'local_cli',
      ready_slots: 0,
      cli_pid: 12,
    },
    'rust',
  )
  assert.equal(out.process_up, true)
  assert.equal(out.reachable, false)
  assert.equal(out.ready_slots, 0)
  assert.equal(out.error_code, 'rust_worker_unavailable')
})

test('rustKernelBusy is slot-full with a live CLI, not unreachable', () => {
  const busy = {
    ok: true,
    status: 200,
    engine: 'rust',
    ready_slots: 0,
    cli_pid: 12,
  }
  assert.equal(rustKernelBusy(busy), true)
  assert.equal(rustKernelReachable(busy), false)
  const wedged = { ok: true, engine: 'rust', ready_slots: 0, worker_version: 'fixture' }
  assert.equal(rustKernelBusy(wedged), false)
  assert.equal(rustKernelReachable(wedged), false)
  const ready = { ok: true, engine: 'rust', ready_slots: 2, cli_pid: 12 }
  assert.equal(rustKernelBusy(ready), false)
  assert.equal(rustKernelReachable(ready), true)
})

test('rustKernelBusy: no free slot because slots are wedged is dead, not busy', () => {
  // Kernel watchdog retired slots whose kin_cancel was never acked. Waiting on
  // "busy" would keep the VM unusable forever; it must fall through to restart.
  const wedged = { ok: true, status: 200, engine: 'rust', ready_slots: 0, cli_pid: 12, wedged_slots: 1 }
  assert.equal(rustKernelBusy(wedged), false)
  assert.equal(rustKernelReachable(wedged), false)
  const partlyWedged = { ok: true, status: 200, engine: 'rust', ready_slots: 3, cli_pid: 12, wedged_slots: 2 }
  assert.equal(rustKernelReachable(partlyWedged), true)
  const busy = { ok: true, status: 200, engine: 'rust', ready_slots: 0, cli_pid: 12, wedged_slots: 0 }
  assert.equal(rustKernelBusy(busy), true)
})

test('toPublicKernelHealth leaves Go hop slot fields null', () => {
  const out = toPublicKernelHealth({ ok: true, status: 200, engine: 'go', worker_version: 'go-1' }, 'go')
  assert.equal(out.reachable, true)
  assert.equal(out.provider, null)
  assert.equal(out.ready_slots, null)
  assert.equal(out.cli_pid, null)
  assert.equal(out.worker_version, 'go-1')
})
