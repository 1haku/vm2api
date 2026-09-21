/**
 * Wrap inference CLI lives in the slot home, next to the Go worker.
 * Create/start copies a prebuilt cli-node ELF (not JS dist / in-slot patch).
 * Engine rust|go only chooses which process serves /v1; both stay on disk.
 * CLI always pre-opens 20 native_messages slots; Node maxConcurrency uses N.
 *
 * Mother sample: share/wrap-cli (or KIN_WRAP_CLI_ROOT) still holds cli-node
 * and glibc. Kernel payload prefers KIN_KERNEL_BIN, then project bin/kin-kernel,
 * then the sample ELF. Promote copies a proven slot; sync overlays the
 * configured kernel. Never copies credentials or proxy URLs.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { kernelBinPath } from '../transport/rust-kernel-supervisor.mjs'

export const WRAP_CLI_FILES = Object.freeze(['cli-node'])
export const WRAP_KERNEL_BIN = 'kin-kernel.bin'
export const WRAP_KERNEL_WRAPPER = 'kin-kernel'
export const WRAP_GLIBC_DIR = 'glibc239'
export const WRAP_GLIBC_LIBS = Object.freeze(['ld-linux-x86-64.so.2', 'libc.so.6', 'libm.so.6', 'libgcc_s.so.1'])

const SECRET_NAMES = new Set(['credentials.json', '.credentials.json', 'oauth.json', '.claude.json', 'internal.token'])

export function wrapKernelWrapperScript() {
  return `#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIN="$DIR/${WRAP_KERNEL_BIN}"
LOADER="$DIR/${WRAP_GLIBC_DIR}/ld-linux-x86-64.so.2"
if [ -x "$LOADER" ] && [ -x "$BIN" ]; then
  exec "$LOADER" --library-path "$DIR/${WRAP_GLIBC_DIR}" "$BIN" "$@"
fi
if [ -x "$BIN" ]; then
  exec "$BIN" "$@"
fi
exec "$DIR/${WRAP_KERNEL_WRAPPER}.real" "$@"
`
}

export function wrapCliTemplateDir(projectRoot) {
  const env = String(process.env.KIN_WRAP_CLI_ROOT || '').trim()
  if (env) return env
  if (!projectRoot) return ''
  return path.join(projectRoot, 'share', 'wrap-cli')
}

export function wrapCliHomeDir(projectRoot, vmId) {
  if (!projectRoot || !vmId) return ''
  return path.join(projectRoot, 'vms', vmId, 'cli-home', '.kin')
}

function isFile(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function hasKernelPayload(dir) {
  return isFile(path.join(dir, WRAP_KERNEL_BIN)) || isFile(path.join(dir, WRAP_KERNEL_WRAPPER))
}

function configuredKernelPath(projectRoot = '') {
  const env = kernelBinPath()
  if (isFile(env)) return env
  if (projectRoot) {
    const bundled = path.join(projectRoot, 'bin', 'kin-kernel')
    if (isFile(bundled)) return bundled
  }
  return ''
}

function kernelPayloadPath(dir, projectRoot = '') {
  const configured = configuredKernelPath(projectRoot)
  if (configured) return configured
  const bin = path.join(dir, WRAP_KERNEL_BIN)
  if (isFile(bin)) return bin
  return path.join(dir, WRAP_KERNEL_WRAPPER)
}

function fileInfo(p) {
  if (!isFile(p)) return null
  const st = fs.statSync(p)
  return { path: p, size: st.size, mtime: st.mtime.toISOString() }
}

export function describeKernelPayload(projectRoot) {
  const dir = wrapCliTemplateDir(projectRoot)
  const configured = configuredKernelPath(projectRoot)
  const sampleBin = path.join(dir, WRAP_KERNEL_BIN)
  const sampleWrap = path.join(dir, WRAP_KERNEL_WRAPPER)
  const chosen = configured || (isFile(sampleBin) ? sampleBin : isFile(sampleWrap) ? sampleWrap : '')
  const info = fileInfo(chosen)
  return {
    source: configured ? 'configured' : chosen ? 'sample' : 'missing',
    path: info?.path || '',
    size: info?.size || 0,
    mtime: info?.mtime || '',
  }
}

export function inspectLinuxAmd64Elf(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (bytes.length < 64) {
    return { ok: false, code: 'kernel_too_small', error: 'kernel binary is too small to be an ELF' }
  }
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    return { ok: false, code: 'kernel_not_elf', error: 'kernel binary is not ELF' }
  }
  if (bytes[4] !== 2) {
    return { ok: false, code: 'kernel_not_elf64', error: 'kernel binary is not ELF64' }
  }
  if (bytes[5] !== 1) {
    return { ok: false, code: 'kernel_not_le', error: 'kernel binary is not little-endian ELF' }
  }
  if (bytes.readUInt16LE(18) !== 62) {
    return { ok: false, code: 'kernel_not_amd64', error: 'kernel binary is not linux amd64' }
  }
  return { ok: true, size: bytes.length }
}

export function inspectWrapCliDir(dir) {
  if (!dir || !fs.existsSync(dir)) {
    return { ok: false, code: 'wrap_cli_template_missing', error: `wrap CLI template missing: ${dir || '(unset)'}` }
  }
  for (const name of WRAP_CLI_FILES) {
    const p = path.join(dir, name)
    if (!isFile(p)) {
      return { ok: false, code: 'wrap_cli_incomplete', error: `wrap CLI missing ${name}` }
    }
  }
  if (!hasKernelPayload(dir)) {
    return { ok: false, code: 'wrap_cli_incomplete', error: 'wrap CLI missing kin-kernel' }
  }
  return {
    ok: true,
    dir,
    kernel_bin: isFile(path.join(dir, WRAP_KERNEL_BIN)),
    glibc_shim: isDir(path.join(dir, WRAP_GLIBC_DIR)),
    wrapper: isFile(path.join(dir, WRAP_KERNEL_WRAPPER)),
  }
}

function sameFile(src, dest) {
  try {
    const a = fs.statSync(src)
    const b = fs.statSync(dest)
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

function filesEqual(src, dest) {
  let a
  let b
  try {
    a = fs.openSync(src, 'r')
    b = fs.openSync(dest, 'r')
    const aStat = fs.fstatSync(a)
    const bStat = fs.fstatSync(b)
    if (aStat.size !== bStat.size) return false
    const aBuf = Buffer.allocUnsafe(64 * 1024)
    const bBuf = Buffer.allocUnsafe(64 * 1024)
    let offset = 0
    while (offset < aStat.size) {
      const length = Math.min(aBuf.length, aStat.size - offset)
      const aRead = fs.readSync(a, aBuf, 0, length, offset)
      const bRead = fs.readSync(b, bBuf, 0, length, offset)
      if (aRead !== bRead || !aBuf.subarray(0, aRead).equals(bBuf.subarray(0, bRead))) return false
      offset += aRead
    }
    return true
  } catch {
    return false
  } finally {
    if (a != null) fs.closeSync(a)
    if (b != null) fs.closeSync(b)
  }
}

function replaceFile(src, dest) {
  if (!src || src === dest || sameFile(src, dest)) return
  if (filesEqual(src, dest)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.new`)
  fs.copyFileSync(src, tmp)
  try {
    fs.chmodSync(tmp, 0o755)
  } catch {}
  try {
    fs.unlinkSync(dest)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw error
    }
  }
  fs.renameSync(tmp, dest)
}

function copyFile(src, dest) {
  replaceFile(src, dest)
}

function copyDir(src, dest) {
  if (!isDir(src)) return
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (SECRET_NAMES.has(name)) continue
    const from = path.join(src, name)
    const to = path.join(dest, name)
    let st
    try {
      st = fs.lstatSync(from)
    } catch {
      continue
    }
    if (st.isDirectory()) copyDir(from, to)
    else if (st.isFile()) replaceFile(from, to)
  }
}

function chownTree(root, uid, gid) {
  if (uid == null && gid == null) return
  const u = Number(uid)
  const g = Number(gid)
  if (!Number.isInteger(u) || !Number.isInteger(g) || u < 0 || g < 0) return
  const walk = (p) => {
    try {
      fs.chownSync(p, u, g)
    } catch {}
    let st
    try {
      st = fs.lstatSync(p)
    } catch {
      return
    }
    if (!st.isDirectory()) return
    let names = []
    try {
      names = fs.readdirSync(p)
    } catch {
      return
    }
    for (const name of names) walk(path.join(p, name))
  }
  walk(root)
}

function writeWrapper(destDir) {
  const wrapper = path.join(destDir, WRAP_KERNEL_WRAPPER)
  const body = wrapKernelWrapperScript()
  try {
    if (fs.readFileSync(wrapper, 'utf8') === body) return
  } catch {}
  const tmp = path.join(destDir, `.${WRAP_KERNEL_WRAPPER}.${process.pid}.new`)
  fs.writeFileSync(tmp, body, { mode: 0o755 })
  try {
    fs.unlinkSync(wrapper)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw error
    }
  }
  fs.renameSync(tmp, wrapper)
}

function installKernelPayload(src, dest, projectRoot = '') {
  const binSrc = kernelPayloadPath(src, projectRoot)
  if (binSrc && isFile(binSrc)) {
    copyFile(binSrc, path.join(dest, WRAP_KERNEL_BIN))
  }
  const glibcSrc = path.join(src, WRAP_GLIBC_DIR)
  if (isDir(glibcSrc)) copyDir(glibcSrc, path.join(dest, WRAP_GLIBC_DIR))
  writeWrapper(dest)
}

export function materializeWrapCli(projectRoot, vm, { uid = null, gid = null } = {}) {
  if (!projectRoot || !vm?.id) {
    return { ok: false, code: 'vm_required', error: 'projectRoot and vm id required' }
  }
  const src = wrapCliTemplateDir(projectRoot)
  const status = inspectWrapCliDir(src)
  if (!status.ok) return status
  const dest = wrapCliHomeDir(projectRoot, vm.id)
  fs.mkdirSync(dest, { recursive: true })
  for (const name of WRAP_CLI_FILES) {
    copyFile(path.join(src, name), path.join(dest, name))
  }
  installKernelPayload(src, dest, projectRoot)
  chownTree(dest, uid, gid)
  return {
    ok: true,
    dest,
    src,
    glibc_shim: isDir(path.join(dest, WRAP_GLIBC_DIR)),
    wrapper: isFile(path.join(dest, WRAP_KERNEL_WRAPPER)),
    kernel_bin: isFile(path.join(dest, WRAP_KERNEL_BIN)),
  }
}

function copyWrapTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const name of WRAP_CLI_FILES) {
    const from = path.join(src, name)
    if (!isFile(from)) continue
    if (SECRET_NAMES.has(name)) continue
    copyFile(from, path.join(dest, name))
  }
  const glibc = path.join(src, WRAP_GLIBC_DIR)
  if (isDir(glibc)) copyDir(glibc, path.join(dest, WRAP_GLIBC_DIR))
  const bin = isFile(path.join(src, WRAP_KERNEL_BIN))
    ? path.join(src, WRAP_KERNEL_BIN)
    : path.join(src, WRAP_KERNEL_WRAPPER)
  if (isFile(bin)) copyFile(bin, path.join(dest, WRAP_KERNEL_BIN))
  writeWrapper(dest)
}

export function captureWrapSample(projectRoot, vm) {
  if (!projectRoot || !vm?.id) {
    return { ok: false, code: 'vm_required', error: 'projectRoot and vm id required' }
  }
  const src = wrapCliHomeDir(projectRoot, vm.id)
  const status = inspectWrapCliDir(src)
  if (!status.ok) {
    return {
      ok: false,
      code: status.code || 'wrap_cli_incomplete',
      error: `slot ${vm.id} is not a usable wrap sample: ${status.error}`,
    }
  }
  const dest = wrapCliTemplateDir(projectRoot)
  if (!dest) return { ok: false, code: 'wrap_cli_template_missing', error: 'wrap CLI template dir unset' }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-wrap-sample-'))
  try {
    copyWrapTree(src, staging)
    const check = inspectWrapCliDir(staging)
    if (!check.ok) return check
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const bak = `${dest}.bak`
    if (fs.existsSync(dest)) {
      fs.rmSync(bak, { recursive: true, force: true })
      fs.renameSync(dest, bak)
    }
    fs.cpSync(staging, dest, { recursive: true, force: true })
    fs.writeFileSync(
      path.join(dest, 'SAMPLE.json'),
      JSON.stringify(
        {
          source_vm: vm.id,
          captured_at: new Date().toISOString(),
          files: WRAP_CLI_FILES.slice(),
          kernel: WRAP_KERNEL_BIN,
          glibc_shim: isDir(path.join(dest, WRAP_GLIBC_DIR)),
        },
        null,
        2,
      ) + '\n',
    )
    return inspectWrapCliDir(dest)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

export function describeWrapSample(projectRoot) {
  const dir = wrapCliTemplateDir(projectRoot)
  const inspect = inspectWrapCliDir(dir)
  let meta = null
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'SAMPLE.json'), 'utf8'))
  } catch {}
  return { ...inspect, dir, meta, kernel: describeKernelPayload(projectRoot) }
}

export function makeWrapSample(projectRoot, { glibcFromDir = '' } = {}) {
  const dest = wrapCliTemplateDir(projectRoot)
  if (!dest) {
    return { ok: false, code: 'wrap_cli_template_missing', error: 'wrap CLI template dir unset' }
  }
  fs.mkdirSync(dest, { recursive: true })
  const kernelDest = path.join(dest, WRAP_KERNEL_BIN)
  const kernelSrc = kernelPayloadPath(dest, projectRoot)
  if (kernelSrc && isFile(kernelSrc) && path.resolve(kernelSrc) !== path.resolve(kernelDest)) {
    replaceFile(kernelSrc, kernelDest)
  }
  const glibcDest = path.join(dest, WRAP_GLIBC_DIR)
  if (!isDir(glibcDest) && glibcFromDir && isDir(glibcFromDir)) {
    copyDir(glibcFromDir, glibcDest)
  }
  writeWrapper(dest)
  const check = inspectWrapCliDir(dest)
  if (!check.ok) {
    return {
      ...check,
      error: `${check.error}。单独制作需要 share/wrap-cli 已有 cli-node；kernel 可从主机 kin-kernel 补。不要从正在跑 wrap 的槽原地覆盖。`,
    }
  }
  fs.writeFileSync(
    path.join(dest, 'SAMPLE.json'),
    JSON.stringify(
      {
        source: 'manual',
        source_vm: '',
        captured_at: new Date().toISOString(),
        files: WRAP_CLI_FILES.slice(),
        kernel: WRAP_KERNEL_BIN,
        glibc_shim: isDir(glibcDest),
      },
      null,
      2,
    ) + '\n',
  )
  return inspectWrapCliDir(dest)
}

function isInsideProject(projectRoot, target) {
  if (!projectRoot || !target) return false
  const root = path.resolve(projectRoot)
  const abs = path.resolve(target)
  return abs === root || abs.startsWith(root + path.sep)
}

function writeKernelBytes(dest, bytes) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.new`)
  fs.writeFileSync(tmp, bytes, { mode: 0o755 })
  try {
    fs.unlinkSync(dest)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw error
    }
  }
  fs.renameSync(tmp, dest)
}

function kernelWriteTargets(projectRoot) {
  const destDir = wrapCliTemplateDir(projectRoot)
  const seen = new Set()
  const targets = []
  const add = (p) => {
    if (!p) return
    const abs = path.resolve(p)
    if (seen.has(abs)) return
    seen.add(abs)
    targets.push(abs)
  }
  add(path.join(destDir, WRAP_KERNEL_BIN))
  if (projectRoot) add(path.join(projectRoot, 'bin', 'kin-kernel'))
  const env = kernelBinPath()
  if (env && isInsideProject(projectRoot, env)) add(env)
  return targets
}

export function replaceKernelBinary(projectRoot, buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  const check = inspectLinuxAmd64Elf(bytes)
  if (!check.ok) return check
  const destDir = wrapCliTemplateDir(projectRoot)
  if (!destDir) {
    return { ok: false, code: 'wrap_cli_template_missing', error: 'wrap CLI template dir unset' }
  }
  fs.mkdirSync(destDir, { recursive: true })
  const written = []
  for (const dest of kernelWriteTargets(projectRoot)) {
    writeKernelBytes(dest, bytes)
    written.push(dest)
  }
  writeWrapper(destDir)
  let meta = {}
  try {
    meta = JSON.parse(fs.readFileSync(path.join(destDir, 'SAMPLE.json'), 'utf8'))
  } catch {}
  fs.writeFileSync(
    path.join(destDir, 'SAMPLE.json'),
    JSON.stringify(
      {
        ...meta,
        source: 'upload',
        captured_at: new Date().toISOString(),
        files: WRAP_CLI_FILES.slice(),
        kernel: WRAP_KERNEL_BIN,
        glibc_shim: isDir(path.join(destDir, WRAP_GLIBC_DIR)),
      },
      null,
      2,
    ) + '\n',
  )
  const described = describeWrapSample(projectRoot)
  return { ...described, ok: true, sample_ok: described.ok, written }
}

export function syncWrapSample(projectRoot, vms, { uidOf } = {}) {
  const sample = describeWrapSample(projectRoot)
  if (!sample.ok) return { ok: false, ...sample, items: [] }
  const items = []
  for (const vm of vms || []) {
    const uid = typeof uidOf === 'function' ? uidOf(vm) : null
    const gid = uid?.gid
    const out = materializeWrapCli(projectRoot, vm, {
      uid: uid?.uid ?? uid,
      gid: gid ?? null,
    })
    items.push({ id: vm.id, ...out })
  }
  const failed = items.filter((item) => !item.ok)
  return {
    ok: failed.length === 0,
    src: sample.dir,
    meta: sample.meta,
    total: items.length,
    ok_count: items.length - failed.length,
    failed_count: failed.length,
    items,
  }
}
