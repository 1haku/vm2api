import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allocateGuestAccount, retireGuestAllocation, resumeGuestAllocation } from '../../src/lib/vm/guest-account.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import {
  beginGuestProvisioning,
  advanceGuestProvisioning,
  cancelGuestProvisioning,
  writeGuestRecord,
  guestProvisioningToken,
  finishGuestStop,
} from '../../src/lib/vm/provisioning.mjs'
import { guestProvisioningReady } from '../../src/lib/vm/guest-contract.mjs'

function instance(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-provisioning-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const id = 'vm-race'
  const account = allocateGuestAccount(root, id, { operationId: 'operation', specHash: 'spec' })
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  const vm = {
    id,
    kernel: 'fedora-44',
    guest_os: { id: 'fedora-44', arch: 'x86_64' },
    runtime: { type: 'docker', provider: 'docker-linux' },
    guest_user: account,
    provisioning: {
      controller_version: 1,
      operation_id: 'operation',
      spec_hash: 'spec',
      generation: 1,
      nonce: 'initial',
      state: 'planned',
    },
  }
  const file = path.join(root, 'vms', `${id}.json`)
  atomicWriteJson(file, vm, { mode: 0o600 })
  return { root, vm, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) }
}

test('cancelled operations reject delayed identity and ready results without restoring eligibility', async (t) => {
  const { root, vm, read } = instance(t)
  const old = await beginGuestProvisioning(vm, root)
  await cancelGuestProvisioning(vm, root)
  const cancelled = read()
  const late = await writeGuestRecord(root, vm, old, (current) => {
    current.guest_user.verified_at = 'late'
    current.provisioning.state = 'slot_ready'
  })
  assert.equal(late.code, 'guest_probe_stale')
  assert.equal((await advanceGuestProvisioning(vm, root, old, 'slot_ready')).code, 'guest_probe_stale')
  assert.deepEqual(read(), cancelled)
  assert.equal(guestProvisioningReady(read()), false)
})

test('a newer generation rejects an old controller snapshot; genuine current proof becomes eligible', async (t) => {
  const { root, vm, read } = instance(t)
  const old = await beginGuestProvisioning(vm, root)
  const stale = structuredClone(vm)
  const next = await beginGuestProvisioning(vm, root)
  assert.notEqual(old.nonce, next.nonce)
  assert.equal(next.generation, old.generation + 1)
  assert.equal((await advanceGuestProvisioning(stale, root, old, 'slot_ready')).code, 'guest_probe_stale')
  assert.equal(read().provisioning.state, 'booting')
  await writeGuestRecord(root, vm, next, (current) => {
    current.guest_user.verified_at = '2026-10-04T00:00:00Z'
  })
  await advanceGuestProvisioning(vm, root, next, 'os_ready')
  assert.equal(guestProvisioningReady(read()), false)
  await advanceGuestProvisioning(vm, root, next, 'slot_ready')
  assert.equal(guestProvisioningReady(read()), true)
  await beginGuestProvisioning(vm, root)
  assert.equal(guestProvisioningReady(read()), false)
  assert.equal(read().guest_user.verified_at, undefined)
})

test('same-generation wrong nonces and terminal failures cannot certify readiness', async (t) => {
  const { root, vm, read } = instance(t)
  const token = await beginGuestProvisioning(vm, root)
  assert.equal(
    (await advanceGuestProvisioning(vm, root, { ...token, nonce: 'wrong' }, 'slot_ready')).code,
    'guest_probe_stale',
  )
  await advanceGuestProvisioning(vm, root, token, 'failed', { errorCode: 'guest_identity_mismatch' })
  const failed = read()
  assert.equal((await advanceGuestProvisioning(vm, root, token, 'slot_ready')).code, 'guest_probe_stale')
  assert.deepEqual(read(), failed)
  assert.equal(guestProvisioningReady(read()), false)
})

test('delayed stop cannot replace a newer generation and deleted guests cannot be revived by probes', async (t) => {
  const { root, vm, read } = instance(t)
  const old = await beginGuestProvisioning(vm, root)
  await cancelGuestProvisioning(vm, root)
  const stopped = structuredClone(vm)
  const revoked = guestProvisioningToken(stopped)
  await beginGuestProvisioning(vm, root)
  const newer = read()
  assert.equal((await finishGuestStop(stopped, root, revoked)).code, 'guest_probe_stale')
  assert.deepEqual(read(), newer)
  fs.unlinkSync(path.join(root, 'vms', `${vm.id}.json`))
  assert.equal((await advanceGuestProvisioning(vm, root, old, 'slot_ready')).code, 'guest_probe_stale')
  assert.equal(fs.existsSync(path.join(root, 'vms', `${vm.id}.json`)), false)
})

test('retirement blocks new generations and late proofs until its own rollback token resumes the guest', async (t) => {
  const { root, vm, read } = instance(t)
  const proof = await beginGuestProvisioning(vm, root)
  const retirement = retireGuestAllocation(root, vm)
  await assert.rejects(beginGuestProvisioning(vm, root), { code: 'guest_probe_stale' })
  assert.equal((await advanceGuestProvisioning(vm, root, proof, 'slot_ready')).code, 'guest_probe_stale')
  resumeGuestAllocation(root, vm, 'foreign-token')
  await assert.rejects(beginGuestProvisioning(vm, root), { code: 'guest_probe_stale' })
  resumeGuestAllocation(root, vm, retirement)
  const next = await beginGuestProvisioning(vm, root)
  assert.equal(next.generation, proof.generation + 1)
  assert.equal(read().provisioning.state, 'booting')
})
