/** Guest OS and artifact metadata. Credential families live in vm-kind.mjs. */
import { runtimeKind, runtimeProvider } from './runtime-kind.mjs'

export const OS_REGISTRY = String(process.env.KIN_OS_REGISTRY || 'ghcr.io/dofastted').replace(/\/+$/, '')

function linux(id, family, pretty, tag, supportLevel = 'supported', baseDigest = null) {
  const candidate = supportLevel === 'candidate'
  return Object.freeze({
    id,
    family,
    osFamily: 'linux',
    goos: 'linux',
    arch: 'x86_64',
    pretty,
    image: `${OS_REGISTRY}/kin-os-${family === 'arch' ? 'arch' : family}:${tag}`,
    dir: id,
    buildContext: candidate ? '.' : id,
    dockerfile: candidate ? `${id}/Dockerfile` : 'Dockerfile',
    artifactKind: 'linux-userland-image',
    supportedRuntimes: ['docker'],
    providers: ['docker-linux'],
    provider: 'docker-linux',
    supportLevel,
    baseDigest,
    accountContract: candidate ? 'linux-account-v2' : 'legacy',
    userProvisioner: candidate ? 'linux-account-v2' : 'legacy-numeric',
    collector: 'linux-docker',
    guestBinaryTargets: ['linux-amd64'],
    minimumResources: { memoryMiB: 1024 },
    licensingPolicy: 'distribution-licenses',
  })
}

function macos(version) {
  return Object.freeze({
    id: `macos-${version}`,
    family: 'macos',
    osFamily: 'macos',
    goos: 'darwin',
    arch: 'x86_64',
    pretty: `macOS ${version}`,
    image: null,
    dir: null,
    buildContext: null,
    artifactKind: 'macos-launcher',
    supportedRuntimes: ['kvm'],
    providers: ['docker-qemu', 'libvirt'],
    supportLevel: 'candidate',
    launcher: { source: 'https://github.com/dockur/macos', digest: null, version: String(version) },
    userProvisioner: 'macos-setup-assistant',
    collector: 'macos-authenticated',
    guestBinaryTargets: ['darwin-amd64'],
    minimumResources: { memoryMiB: 8192 },
    licensingPolicy: 'review-required',
  })
}

export const OS_CATALOG = Object.freeze({
  'ubuntu-24.04': linux('ubuntu-24.04', 'ubuntu', 'Ubuntu 24.04', '24.04'),
  'debian-12': linux('debian-12', 'debian', 'Debian 12', '12'),
  archlinux: linux('archlinux', 'arch', 'Arch Linux', 'latest'),
  'fedora-41': linux('fedora-41', 'fedora', 'Fedora 41', '41'),
  'debian-13': linux(
    'debian-13',
    'debian',
    'Debian 13',
    '13',
    'candidate',
    'sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c',
  ),
  'ubuntu-26.04': linux(
    'ubuntu-26.04',
    'ubuntu',
    'Ubuntu 26.04',
    '26.04',
    'candidate',
    'sha256:3595d7fc4286a33fad0fd853a4063e654287a9c3787437d7937c94ca3f7a804e',
  ),
  'fedora-44': linux(
    'fedora-44',
    'fedora',
    'Fedora 44',
    '44',
    'candidate',
    'sha256:43b29f65a41eb9c35e1cd5323e3bdf3b655c2357a9f4f1ff2f9c2798e5045d80',
  ),
  'macos-15': macos(15),
  'macos-14': macos(14),
})

// Preserve assignment of every legacy numbered slot; candidates are explicit-only.
export const OS_ORDER = Object.freeze(['ubuntu-24.04', 'debian-12', 'archlinux', 'fedora-41'])

export function guestContractError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status })
}

export function osForId(value, defaultId = 'ubuntu-24.04') {
  const id = value == null || value === '' ? defaultId : value
  if (typeof id !== 'string' || !Object.hasOwn(OS_CATALOG, id)) {
    throw guestContractError('unknown_os', 'Unknown guest operating system')
  }
  return OS_CATALOG[id]
}

export function resolveGuestSpec(vm = {}, { defaultKernel = 'ubuntu-24.04' } = {}) {
  if (vm.guest_os != null && (typeof vm.guest_os !== 'object' || Array.isArray(vm.guest_os))) {
    throw guestContractError('unknown_os', 'guest_os must be an OS reference')
  }
  const guestId = vm.guest_os?.id
  const legacyId = vm.kernel
  const guest = guestId == null || guestId === '' ? null : osForId(guestId)
  const legacy = legacyId == null || legacyId === '' ? null : osForId(legacyId)
  if (guest && legacy && guest.id !== legacy.id) {
    throw guestContractError('os_fields_conflict', 'kernel and guest_os.id select different operating systems')
  }
  const os = guest || legacy || osForId(defaultKernel)
  const rawArch = vm.guest_os?.arch || os.arch
  const arch = rawArch === 'amd64' ? 'x86_64' : rawArch === 'arm64' ? 'aarch64' : rawArch
  if (arch !== os.arch) throw guestContractError('host_arch_mismatch', 'Guest architecture has no supported artifact')
  const type = runtimeKind(vm)
  if (!os.supportedRuntimes.includes(type)) {
    throw guestContractError('os_runtime_mismatch', 'Guest operating system does not support the requested runtime')
  }
  const provider = runtimeProvider(vm, type)
  if (os.osFamily === 'macos' && !vm.runtime?.provider) {
    throw guestContractError('unknown_runtime', 'macOS requires an explicit reviewed VM provider')
  }
  if (!os.providers.includes(provider)) {
    throw guestContractError('os_runtime_mismatch', 'Guest operating system does not support the requested provider')
  }
  return {
    os,
    kernel: os.id,
    guest_os: { id: os.id, family: os.family, arch },
    runtime: { type, provider },
    v2: vm.guest_os != null || os.accountContract === 'linux-account-v2' || os.osFamily === 'macos',
  }
}

export function assertGuestCreatable(spec, { remote = false } = {}) {
  if (spec.os.osFamily === 'macos') {
    throw guestContractError(
      'macos_license_review_required',
      'macOS is unavailable: a reviewed license, authorized KVM host, initialized guest and native Darwin products are required',
      409,
    )
  }
  if (remote && spec.os.supportLevel !== 'supported') {
    throw guestContractError(
      'remote_unsupported',
      'Candidate guest account images are not supported on cluster nodes',
      409,
    )
  }
  return spec
}

export function imageForKernel(kernel) {
  const os = osForId(kernel)
  if (os.artifactKind !== 'linux-userland-image' || !os.image) {
    throw guestContractError('os_runtime_mismatch', 'This OS requires a VM artifact, not a Linux Docker image')
  }
  return os.image
}

/** Build context under docker/kin-os; Dockerfile is separately catalogued. */
export function buildDirForKernel(kernel) {
  imageForKernel(kernel)
  return osForId(kernel).buildContext
}
