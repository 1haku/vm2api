import { resolveGuestSpec } from './os-catalog.mjs'

/** Private records are authoritative; user-provided API metadata cannot certify readiness. */
export function guestProvisioningReady(vm) {
  if (!vm) return false
  let spec
  try {
    spec = resolveGuestSpec(vm)
  } catch {
    return false
  }
  if (spec.os.osFamily === 'macos' || spec.runtime.type !== 'docker') return false
  if (!vm.guest_os && !vm.provisioning && !vm.guest_user && !spec.v2) return true
  const provision = vm.provisioning
  if (
    vm.guest_user?.contract !== 'linux-account-v2' ||
    typeof vm.guest_user.verified_at !== 'string' ||
    !vm.guest_user.verified_at
  )
    return false
  return (
    provision?.state === 'slot_ready' &&
    provision.controller_version === 1 &&
    Number.isSafeInteger(provision.generation) &&
    provision.generation > 0 &&
    typeof provision.operation_id === 'string' &&
    !!provision.operation_id &&
    typeof provision.spec_hash === 'string' &&
    !!provision.spec_hash &&
    provision.verified_generation === provision.generation
  )
}

function scalars(source, keys) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const view = {}
  for (const key of keys) {
    const value = source[key]
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) view[key] = value
  }
  return view
}

export function publicGuestMetadata(vm) {
  return {
    guest_os: scalars(vm.guest_os, ['id', 'family', 'arch']),
    guest_user: scalars(vm.guest_user, ['contract', 'username', 'uid', 'gid', 'home', 'verified_at']),
    provisioning: scalars(vm.provisioning, [
      'operation_id',
      'state',
      'generation',
      'spec_hash',
      'stage_started_at',
      'error_code',
      'retryable',
      'last_probe_at',
      'controller_version',
      'verified_generation',
    ]),
    runtime: scalars(vm.runtime, [
      'type',
      'provider',
      'container',
      'pid',
      'ip',
      'network',
      'network_mode',
      'started_at',
      'image',
      'hostname',
      'os',
      'memory',
      'user',
      'worker',
      'engine',
      'egress',
      'guest_hostname',
      'guest_os',
      'guest_kernel',
      'identity_collected_at',
      'codex_kernel',
      'status',
    ]),
  }
}

export function publicGuestFingerprint(vm) {
  return scalars(vm.fingerprint, [
    'hostname',
    'guest_hostname',
    'os_id',
    'os_pretty',
    'kernel_release',
    'guest_kernel_release',
    'arch',
    'timezone',
    'locale',
    'runtime_kind',
    'collected_at',
    'version',
  ])
}
