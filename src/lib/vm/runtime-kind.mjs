export const RUNTIME_DOCKER = 'docker'
export const RUNTIME_KVM = 'kvm'

const KVM_ALIASES = new Set(['kvm', 'qemu', 'libvirt'])

/** Only absent legacy metadata defaults to Docker. Unknown values fail closed. */
export function runtimeKind(vm = {}) {
  const nested = vm?.runtime?.type
  const legacy = vm?.runtime_type
  const normalize = (value) => {
    const raw = String(value || '')
      .trim()
      .toLowerCase()
    if (!raw || raw === RUNTIME_DOCKER) return RUNTIME_DOCKER
    if (KVM_ALIASES.has(raw)) return RUNTIME_KVM
    throw Object.assign(new Error('Unknown guest runtime'), { code: 'unknown_runtime', status: 400 })
  }
  const type = normalize(nested || legacy)
  if (nested && legacy && type !== normalize(legacy)) {
    throw Object.assign(new Error('Conflicting guest runtime types'), { code: 'unknown_runtime', status: 400 })
  }
  return type
}

export function runtimeProvider(vm, type = runtimeKind(vm)) {
  const provider = vm?.runtime?.provider
  if (!provider) return type === RUNTIME_DOCKER ? 'docker-linux' : 'libvirt'
  const allowed = type === RUNTIME_DOCKER ? ['docker-linux'] : ['docker-qemu', 'libvirt']
  if (!allowed.includes(provider)) {
    throw Object.assign(new Error('Unknown or incompatible guest provider'), { code: 'unknown_runtime', status: 400 })
  }
  return provider
}

export function isKvmRuntime(vm) {
  return runtimeKind(vm) === RUNTIME_KVM
}
