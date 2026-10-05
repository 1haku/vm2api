import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteJson, isValidVmId, withVmLock } from './vm-file.mjs'
import { GUEST_ACCOUNT_V2, withGuestAccountLock } from './guest-account.mjs'

export function guestProvisioningToken(vm) {
  const p = vm?.provisioning
  if (vm?.guest_user?.contract !== GUEST_ACCOUNT_V2 || !p) return null
  return { operation_id: p.operation_id, generation: p.generation, spec_hash: p.spec_hash, nonce: p.nonce }
}

function sameOperation(current, token) {
  const p = current?.provisioning
  return (
    p &&
    ['operation_id', 'generation', 'spec_hash', 'nonce'].every((key) => p[key] === token[key]) &&
    p.state !== 'cancelled' &&
    p.state !== 'failed'
  )
}

export function guestOperationCurrent(vm, projectRoot, { active = true } = {}) {
  if (vm?.guest_user?.contract !== GUEST_ACCOUNT_V2) return true
  const token = guestProvisioningToken(vm)
  if (!token) return false
  try {
    const current = JSON.parse(fs.readFileSync(path.join(projectRoot, 'vms', `${vm.id}.json`), 'utf8'))
    return active
      ? sameOperation(current, token)
      : ['operation_id', 'generation', 'spec_hash', 'nonce'].every((key) => current.provisioning?.[key] === token[key])
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

/** Short synchronous file mutations run inside both the VM mutex and the shared SQLite writer lock. */
export function writeGuestRecord(projectRoot, vm, token, change) {
  if (!isValidVmId(vm?.id)) throw new Error('Invalid guest VM identifier')
  const file = path.join(projectRoot, 'vms', `${vm.id}.json`)
  return withVmLock(file, () => {
    const mutate = (allocation) => {
      let current
      try {
        current = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return { ok: false, code: 'guest_probe_stale', error: 'Guest no longer exists' }
        throw error
      }
      if (token && !sameOperation(current, token))
        return { ok: false, code: 'guest_probe_stale', error: 'Guest operation changed while probing' }
      if (token && allocation?.retired) return { ok: false, code: 'guest_probe_stale', error: 'Guest is being deleted' }
      const result = change(current, allocation)
      if (result?.ok === false) return result
      current.updated_at = new Date().toISOString()
      if (current.provisioning)
        atomicWriteJson(path.join(projectRoot, 'vms', vm.id, 'provisioning.json'), current.provisioning, {
          mode: 0o600,
        })
      atomicWriteJson(file, current, { mode: 0o600 })
      Object.assign(vm, current)
      return { ok: true, vm: current, result }
    }
    return vm.guest_user?.contract === GUEST_ACCOUNT_V2 ? withGuestAccountLock(projectRoot, vm.id, mutate) : mutate()
  })
}

export async function beginGuestProvisioning(vm, projectRoot) {
  if (!guestProvisioningToken(vm)) return null
  const changed = await writeGuestRecord(projectRoot, vm, null, (current, allocation) => {
    if (allocation?.retired) return { ok: false, code: 'guest_probe_stale', error: 'Guest is being deleted' }
    const p = current.provisioning
    if (
      !p ||
      p.controller_version !== 1 ||
      !Number.isSafeInteger(p.generation) ||
      p.generation < 1 ||
      p.generation >= Number.MAX_SAFE_INTEGER ||
      !p.operation_id ||
      !p.spec_hash
    ) {
      return { ok: false, code: 'guest_provisioning_invalid', error: 'Guest has no valid provisioning operation' }
    }
    current.provisioning = {
      ...p,
      generation: p.generation + 1,
      nonce: crypto.randomBytes(16).toString('hex'),
      state: 'booting',
      stage_started_at: new Date().toISOString(),
      error_code: null,
      retryable: false,
    }
    delete current.provisioning.verified_generation
    delete current.guest_user.verified_at
    current.schedulable = false
    current.schedule_disabled_reason = 'guest_not_ready'
  })
  if (!changed.ok) throw Object.assign(new Error(changed.error), { code: changed.code })
  return guestProvisioningToken(vm)
}

export async function advanceGuestProvisioning(
  vm,
  projectRoot,
  token,
  state,
  { errorCode = null, retryable = false, runtime } = {},
) {
  if (!token) return null
  return writeGuestRecord(projectRoot, vm, token, (current) => {
    if (runtime) current.runtime = { ...current.runtime, ...runtime }
    current.provisioning = {
      ...current.provisioning,
      state,
      stage_started_at: new Date().toISOString(),
      last_probe_at: new Date().toISOString(),
      error_code: errorCode,
      retryable,
    }
    if (state === 'failed') {
      current.status = 'error'
      current.schedulable = false
    }
    if (state === 'slot_ready') current.provisioning.verified_generation = token.generation
    else delete current.provisioning.verified_generation
  })
}

export async function cancelGuestProvisioning(vm, projectRoot) {
  if (!guestProvisioningToken(vm)) return null
  if (!projectRoot) throw new Error('Guest cancellation requires a project root')
  return writeGuestRecord(projectRoot, vm, null, (current) => {
    current.provisioning = {
      ...current.provisioning,
      generation: current.provisioning.generation + 1,
      nonce: crypto.randomBytes(16).toString('hex'),
      state: 'cancelled',
      stage_started_at: new Date().toISOString(),
    }
    delete current.provisioning.verified_generation
    current.schedulable = false
  })
}

export async function finishGuestStop(vm, projectRoot, expected) {
  return writeGuestRecord(projectRoot, vm, null, (current) => {
    const token = guestProvisioningToken(current)
    if (['operation_id', 'generation', 'spec_hash', 'nonce'].some((key) => token?.[key] !== expected?.[key])) {
      return { ok: false, code: 'guest_probe_stale', error: 'Guest operation changed while stopping' }
    }
    current.status = 'stopped'
    current.schedulable = false
    current.schedule_disabled_reason = 'stopped'
    current.runtime = { ...current.runtime, ...vm.runtime }
  })
}
