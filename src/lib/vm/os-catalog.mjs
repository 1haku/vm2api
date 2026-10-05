/**
 * Guest OS catalog. Images are pulled from a registry; the Dockerfiles under
 * docker/kin-os are the offline fallback and are tagged with the same ref.
 * KIN_OS_REGISTRY lets a self-hoster mirror them.
 */
export const OS_REGISTRY = String(process.env.KIN_OS_REGISTRY || 'ghcr.io/dofastted').replace(/\/+$/, '')

export const OS_CATALOG = {
  'ubuntu-24.04': {
    image: `${OS_REGISTRY}/kin-os-ubuntu:24.04`,
    family: 'ubuntu',
    pretty: 'Ubuntu 24.04',
    dir: 'ubuntu-24.04',
  },
  'debian-12': {
    image: `${OS_REGISTRY}/kin-os-debian:12`,
    family: 'debian',
    pretty: 'Debian 12',
    dir: 'debian-12',
  },
  archlinux: {
    image: `${OS_REGISTRY}/kin-os-arch:latest`,
    family: 'arch',
    pretty: 'Arch Linux',
    dir: 'archlinux',
  },
  'fedora-41': {
    image: `${OS_REGISTRY}/kin-os-fedora:41`,
    family: 'fedora',
    pretty: 'Fedora 41',
    dir: 'fedora-41',
  },
}

export const OS_ORDER = ['ubuntu-24.04', 'debian-12', 'archlinux', 'fedora-41']

export function imageForKernel(kernel) {
  return (OS_CATALOG[kernel] || OS_CATALOG['ubuntu-24.04']).image
}

/** Build context dir name under docker/kin-os for the offline fallback. */
export function buildDirForKernel(kernel) {
  return (OS_CATALOG[kernel] || OS_CATALOG['ubuntu-24.04']).dir
}
