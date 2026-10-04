import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OS_ORDER, imageForKernel, resolveGuestSpec } from '../../src/lib/vm/os-catalog.mjs'
import { guestProvisioningReady } from '../../src/lib/vm/guest-contract.mjs'
import { isVmScheduleReady, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import { evaluateSlotGate } from '../../src/lib/pool/schedule-eligibility.mjs'
import { isCodexSlotReady } from '../../src/lib/pool/codex-slot-pool.mjs'
import { isHealthProbeTarget } from '../../src/lib/admin/health-probe.mjs'
import { startVmRuntime } from '../../src/lib/vm/vm-runtime.mjs'

function rejects(fn, code) {
  assert.throws(fn, (error) => error.code === code)
}

test('only missing legacy OS defaults; explicit unknown and prototype keys fail', () => {
  assert.equal(resolveGuestSpec({}).kernel, 'ubuntu-24.04')
  assert.equal(imageForKernel('debian-12').endsWith('/kin-os-debian:12'), true)
  assert.deepEqual(OS_ORDER, ['ubuntu-24.04', 'debian-12', 'archlinux', 'fedora-41'])
  for (const kernel of ['not-an-os', '__proto__', 'constructor', 'toString']) {
    rejects(() => imageForKernel(kernel), 'unknown_os')
    rejects(() => resolveGuestSpec({ kernel }), 'unknown_os')
  }
})

test('OS conflict, architecture, runtime and artifact are independent hard errors', () => {
  rejects(() => resolveGuestSpec({ kernel: 'debian-12', guest_os: { id: 'ubuntu-24.04' } }), 'os_fields_conflict')
  rejects(() => resolveGuestSpec({ kernel: 'debian-13', guest_os: { arch: 'arm64' } }), 'host_arch_mismatch')
  rejects(() => resolveGuestSpec({ runtime_type: 'typo' }), 'unknown_runtime')
  rejects(() => resolveGuestSpec({ runtime: { provider: 'docker-qemu' } }), 'unknown_runtime')
  rejects(() => resolveGuestSpec({ kernel: 'macos-15' }), 'os_runtime_mismatch')
  rejects(() => imageForKernel('macos-15'), 'os_runtime_mismatch')
  const mac = resolveGuestSpec({ guest_os: { id: 'macos-15' }, runtime: { type: 'kvm', provider: 'docker-qemu' } })
  assert.equal(mac.os.goos, 'darwin')
  assert.equal(mac.runtime.type, 'kvm')
})

test('invalid direct runtime start returns an error before directories or container operations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-invalid-guest-'))
  try {
    const out = await startVmRuntime({ id: 'vm-no-fallback', kernel: 'constructor' }, root)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'unknown_os')
    assert.deepEqual(fs.readdirSync(root), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('OS readiness cannot bypass provisioning through OAuth, Codex, or health probes', () => {
  const vm = {
    id: 'vm-new',
    kernel: 'debian-13',
    guest_os: { id: 'debian-13', arch: 'x86_64' },
    status: 'running',
    schedulable: true,
    proxy_cli_enabled: true,
    proxy: { id: 'px-local', type: 'local' },
    claude: { has_access: true },
    has_token: true,
    provisioning: {
      state: 'os_ready',
      controller_version: 1,
      generation: 2,
      operation_id: 'op',
      spec_hash: 'hash',
      verified_generation: 1,
    },
  }
  assert.equal(isVmScheduleReady(vm), false)
  assert.equal(evaluateSlotGate({ ...vm, schedule_disabled_reason: 'oauth_retryable' }).ok, false)
  assert.equal(isCodexSlotReady({ ...vm, platform: 'openai', family: 'codex' }), false)
  assert.equal(isHealthProbeTarget(vm), false)
  vm.provisioning.state = 'slot_ready'
  assert.equal(guestProvisioningReady(vm), false, 'late previous-generation proof is rejected')
  vm.provisioning.verified_generation = 2
  assert.equal(guestProvisioningReady(vm), false, 'a controller marker alone cannot certify a guest account')
  vm.guest_user = {
    contract: 'linux-account-v2',
    username: 'guest_new',
    uid: 20001,
    gid: 20001,
    home: '/home/guest_new',
    verified_at: '2026-10-04T00:00:00Z',
  }
  assert.equal(guestProvisioningReady(vm), true)
  assert.equal(isVmScheduleReady(vm), true)
  assert.equal(guestProvisioningReady({ ...vm, provisioning: { ...vm.provisioning, state: 'cancelled' } }), false)
  assert.equal(guestProvisioningReady({ ...vm, provisioning: { state: 'slot_ready' } }), false)
})

test('legacy credential and scheduling semantics remain, unknown runtime is unavailable', () => {
  const vm = { id: 'vm-01', status: 'running', claude: { has_access: true } }
  assert.equal(isVmScheduleReady(vm), true)
  assert.equal(isVmScheduleReady({ ...vm, schedulable: false }), false)
  assert.equal(isVmScheduleReady({ ...vm, runtime: { type: 'typo' } }), false)
})

test('public guest projection cannot leak identity, bootstrap credentials or nested secrets', () => {
  const vm = {
    id: 'vm-new',
    platform: 'anthropic',
    family: 'claude',
    guest_os: { id: 'debian-13', arch: 'x86_64', secret: 'private' },
    guest_user: {
      username: 'guest_abc',
      uid: 20001,
      gid: 20001,
      home: '/home/guest_abc',
      uuid: 'private',
      password: 'private',
    },
    fingerprint: { hostname: 'guest', serial: 'private', machine_id: 'private', device_id: 'private' },
    runtime: { type: 'docker', provider: 'docker-linux', internal_token: 'private', os: { secret: 'private' } },
    provisioning: { state: 'planned', nonce: 'private', control_secret: 'private' },
  }
  const snapshot = JSON.stringify(vm)
  const view = summarizeVm(vm)
  assert.equal(view.family, 'claude')
  assert.equal(view.guest_user.username, 'guest_abc')
  assert.equal(view.runtime.provider, 'docker-linux')
  assert.equal(JSON.stringify(view).includes('private'), false)
  assert.equal(JSON.stringify(vm), snapshot, 'projection never rotates stored OAuth or OS identity')
})
