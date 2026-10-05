/**
 * Isolated QEMU lifecycle for open-source Darwin experiments (PureDarwin).
 *
 * Nothing here touches slots, the gateway, Docker or vms/: one private lab root
 * holds verified bases, per-instance copy-on-write overlays, serial logs and state;
 * a Linux-filesystem runtime directory holds the QMP socket and kernel-released locks.
 *
 * Status layers are separate facts:
 * - host: owned QEMU process plus QMP run state and `query-kvm`;
 * - guest_os: a Darwin kernel banner actually emitted on this generation's serial log;
 * - product: never inferred; no guest command channel exists, so it stays unproven.
 * Licensed macOS never runs here; it stays behind macos-admission.
 */
import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { OS_CATALOG } from './os-catalog.mjs'
import { atomicWriteJson } from './vm-file.mjs'
import { qmpConnect } from './qemu-qmp.mjs'

export const DARWIN_LAB_PROFILES = Object.freeze({
  'puredarwin-17.4': Object.freeze({
    id: 'puredarwin-17.4',
    pretty: 'PureDarwin 17.4 Beta (2018 re-release)',
    licensing: 'open-source',
    arch: 'x86_64',
    darwinMajor: 17,
    source: Object.freeze({
      url: 'https://github.com/PureDarwin/PureDarwin/releases/download/17.4/pd_17_4.vmdk.xz',
      sha256: 'f2bb10f2fdb309a9a4fc77083c17b5a145db132551449a01b115f470d86c317c',
      format: 'vmdk.xz',
    }),
    disk: Object.freeze({ format: 'vmdk', bus: 'ide' }),
    machine: 'pc',
    cpu: 'Penryn',
    firmware: 'bios-256k.bin',
    // Upstream recommendation, not a measured minimum.
    resources: Object.freeze({ memoryMiB: 8192, cpus: 2 }),
    limits: Object.freeze({ memoryMiB: [1024, 16384], cpus: [1, 8] }),
  }),
})

const LAB_MARKER = 'darwin-lab.json'
const INSTANCE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
// Paths reach QEMU key=value options; refuse anything that could split an option.
const SAFE_PATH = /^\/[A-Za-z0-9._@+/-]+$/
const SERIAL_SCAN_BYTES = 8 * 1024 * 1024
const LOG_TAIL_BYTES = 4096
const HOST_MEMORY_RESERVE_MIB = 1024
const PREPARE_SPACE_MARGIN = 1024 ** 3
const QMP_READY_MS = 30000
const STOP_TIMEOUT_MS = 60000
const KILL_WAIT_MS = 5000
const DARWIN_BANNER = /Darwin Kernel Version (\d+)\.(\d+)\.(\d+)[^\r\n]*/

export function labError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

function isInside(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function profileFor(variant) {
  if (Object.hasOwn(DARWIN_LAB_PROFILES, variant)) return DARWIN_LAB_PROFILES[variant]
  if (OS_CATALOG[variant]?.osFamily === 'macos') {
    throw labError(
      'macos_license_review_required',
      'Licensed macOS guests are admitted only through approved macOS records; this lab runs open-source Darwin',
    )
  }
  throw labError('darwin_lab_variant_unknown', `Unknown Darwin lab variant: ${variant}`)
}

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(4 * 1024 * 1024)
    for (let n = fs.readSync(fd, buf); n > 0; n = fs.readSync(fd, buf)) hash.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return hash.digest('hex')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(dir)
  const euid = process.geteuid()
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== euid || (st.mode & 0o077) !== 0) {
    throw labError('darwin_lab_runtime_unsafe', `Runtime directory is not a private directory of uid ${euid}: ${dir}`)
  }
  return dir
}

/**
 * Opens a lab root. `create` writes the marker for a new lab; every other command
 * requires an existing marker so a mistyped path never becomes a lab. `dataVolume`
 * refuses roots on the root filesystem before anything is written.
 */
export function openLab({ labRoot, projectRoot = null, create = false, dataVolume = false }) {
  if (!labRoot) throw labError('darwin_lab_root_required', '--lab-root is required')
  let root
  try {
    root = fs.realpathSync(labRoot)
  } catch {
    throw labError('darwin_lab_root_missing', `Lab root does not exist: ${labRoot}`)
  }
  if (!fs.statSync(root).isDirectory())
    throw labError('darwin_lab_root_missing', `Lab root is not a directory: ${root}`)
  if (!SAFE_PATH.test(root))
    throw labError('darwin_lab_path_unsafe', `Lab root path has unsupported characters: ${root}`)
  if (projectRoot) {
    const project = fs.realpathSync(projectRoot)
    const protectedDirs = [project, ...['vms', 'data', 'bin', 'share'].map((name) => path.join(project, name))]
    if (protectedDirs.some((dir) => isInside(dir, root) || (dir !== project && isInside(root, dir)))) {
      throw labError('darwin_lab_root_unsafe', 'Lab root must not contain or live inside production directories')
    }
  }
  // Large lab artifacts must not fill the WSL root filesystem.
  if (dataVolume && fs.statSync(root).dev === fs.statSync('/').dev) {
    throw labError('darwin_lab_root_unsafe', 'Lab root is on the root filesystem; use a dedicated data volume')
  }
  const markerFile = path.join(root, LAB_MARKER)
  let marker = readJson(markerFile)
  if (!marker) {
    if (!create) throw labError('darwin_lab_uninitialized', `No ${LAB_MARKER} in ${root}; run prepare first`)
    marker = {
      lab_id: crypto.randomBytes(8).toString('hex'),
      root,
      owner_uid: process.geteuid(),
      created_at: new Date().toISOString(),
    }
    try {
      fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      marker = readJson(markerFile)
    }
  }
  if (!/^[a-f0-9]{16}$/.test(String(marker?.lab_id)))
    throw labError('darwin_lab_marker_invalid', `Invalid ${markerFile}`)
  // Root and operator are part of the lease scope; copied markers or uid changes cannot borrow it.
  if (marker.root !== root || marker.owner_uid !== process.geteuid()) {
    throw labError('darwin_lab_owner_unproven', 'Lab marker belongs to a different root or operator')
  }
  const runtimeDir = path.join(os.tmpdir(), `kin-darwin-lab-${process.geteuid()}`, marker.lab_id)
  if (!SAFE_PATH.test(runtimeDir))
    throw labError('darwin_lab_path_unsafe', `Runtime path is unsupported: ${runtimeDir}`)
  // sun_path holds 107 bytes; reserve room for `/<instance id>/qmp.sock`.
  if (runtimeDir.length + 42 > 107)
    throw labError('darwin_lab_path_unsafe', `Runtime path is too long for a socket: ${runtimeDir}`)
  ensurePrivateDir(path.dirname(runtimeDir))
  ensurePrivateDir(runtimeDir)
  return { root, labId: marker.lab_id, runtimeDir }
}

/**
 * Exclusive lease held for the whole callback. SQLite's file lock is released by the
 * kernel when the holder dies, so a crashed holder never leaves a stale lease.
 */
async function withLease(lab, name, fn) {
  const db = new DatabaseSync(path.join(lab.runtimeDir, `${name}.lease`))
  try {
    db.exec('PRAGMA busy_timeout = 0')
    try {
      db.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      if (error.errcode === 5) throw labError('darwin_lab_busy', `Another operation holds ${name}`)
      throw error
    }
    try {
      return await fn()
    } finally {
      db.exec('ROLLBACK')
    }
  } finally {
    db.close()
  }
}

/** Acquires leases in the given order; every caller uses instance-before-lab order. */
function withLeases(lab, names, fn) {
  if (!names.length) return fn()
  const [first, ...rest] = names
  return withLease(lab, first, () => withLeases(lab, rest, fn))
}

function checkedLabPath(lab, ...parts) {
  let dir = lab.root
  for (const part of parts) {
    dir = path.join(dir, part)
    let st
    try {
      st = fs.lstatSync(dir)
    } catch (error) {
      if (error.code === 'ENOENT') break
      throw error
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw labError('darwin_lab_path_unsafe', `Lab directory must not be a symlink or file: ${dir}`)
    }
  }
  return path.join(lab.root, ...parts)
}

function baseDir(lab, variant) {
  return checkedLabPath(lab, 'bases', variant)
}

function readBase(lab, profile) {
  const dir = baseDir(lab, profile.id)
  const manifest = readJson(path.join(dir, 'manifest.json'))
  if (!manifest) throw labError('darwin_lab_base_missing', `Base ${profile.id} is not prepared`)
  if (manifest.base?.file !== `disk.${profile.disk.format}`) {
    throw labError('darwin_lab_base_changed', 'Base manifest names an unexpected disk file')
  }
  const file = path.join(dir, manifest.base.file)
  let st
  try {
    st = fs.statSync(file)
  } catch {
    throw labError('darwin_lab_base_changed', `Prepared base disk is missing: ${file}`)
  }
  if (st.size !== manifest.base.bytes || st.mtimeMs !== manifest.base.mtime_ms) {
    throw labError('darwin_lab_base_changed', 'Prepared base disk differs from its manifest')
  }
  return { manifest, file }
}

function decompressXz(source, target) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    // The base is immutable once published; QEMU also opens it read-only behind the overlay.
    const out = fs.createWriteStream(target, { flags: 'wx', mode: 0o444 })
    const child = spawn('xz', ['--decompress', '--stdout', '--', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    })
    let bytes = 0
    let stderr = ''
    let failed = null
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
    })
    child.stdout.pipe(out)
    child.stderr.on('data', (chunk) => {
      if (stderr.length < LOG_TAIL_BYTES) stderr += chunk
    })
    child.on('error', (error) => {
      // A failed spawn never ends stdout, so close the target and settle here.
      failed = error
      exit = -1
      out.destroy()
    })
    out.on('error', (error) => {
      failed = error
      child.kill('SIGKILL')
    })
    let exit = null
    let flushed = false
    const done = () => {
      if (exit === null || !flushed) return
      if (failed) return reject(failed)
      if (exit !== 0) return reject(labError('darwin_lab_decompress_failed', `xz exited ${exit}: ${stderr.trim()}`))
      resolve({ bytes, sha256: hash.digest('hex') })
    }
    child.on('close', (code) => {
      if (exit === null) exit = code ?? 1
      done()
    })
    out.on('close', () => {
      flushed = true
      done()
    })
  })
}

function xzUncompressedBytes(source) {
  const listing = execFileSync('xz', ['--robot', '--list', '--', source], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin' },
  })
  const totals = listing.split('\n').find((line) => line.startsWith('totals\t'))
  const bytes = Number(totals?.split('\t')[4])
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw labError('darwin_lab_source_invalid', 'Unreadable xz index')
  return bytes
}

/**
 * Verifies the pinned upstream archive hash and decompresses it once into
 * bases/<variant>/. An existing base is reused only when its manifest matches.
 */
export async function prepareBase(lab, { variant, source }) {
  const profile = profileFor(variant)
  if (!source) throw labError('darwin_lab_source_required', '--source is required')
  let src
  try {
    src = fs.realpathSync(source)
  } catch {
    throw labError('darwin_lab_source_missing', `Source does not exist: ${source}`)
  }
  if (!isInside(src, lab.root) || !fs.statSync(src).isFile()) {
    throw labError('darwin_lab_source_unsafe', 'Source must be a regular file inside the lab root')
  }
  return withLease(lab, 'lab', async () => {
    const dir = baseDir(lab, profile.id)
    const manifestFile = path.join(dir, 'manifest.json')
    const existing = readJson(manifestFile)
    if (existing) {
      if (existing.source.sha256 !== profile.source.sha256) {
        throw labError('darwin_lab_base_conflict', `bases/${profile.id} holds a different source`)
      }
      readBase(lab, profile)
      return { reused: true, manifest: existing }
    }
    const sourceSha = sha256File(src)
    if (sourceSha !== profile.source.sha256) {
      throw labError('darwin_lab_source_mismatch', 'Source SHA-256 does not match the pinned upstream release', {
        expected: profile.source.sha256,
        actual: sourceSha,
      })
    }
    const expectedBytes = xzUncompressedBytes(src)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = `disk.${profile.disk.format}`
    // The lab lease is held and no manifest references these files, so they are
    // leftovers of a crashed earlier prepare and no instance can be using them.
    for (const name of fs.readdirSync(dir)) {
      if (name === file || (name.startsWith(`.${file}.`) && name.endsWith('.partial'))) fs.rmSync(path.join(dir, name))
    }
    const free = fs.statfsSync(dir)
    if (free.bavail * free.bsize < expectedBytes + PREPARE_SPACE_MARGIN) {
      throw labError('darwin_lab_insufficient_space', 'Not enough free space to decompress the base', {
        need_bytes: expectedBytes + PREPARE_SPACE_MARGIN,
        free_bytes: free.bavail * free.bsize,
      })
    }
    const partial = path.join(dir, `.${file}.${process.pid}.partial`)
    let written
    try {
      written = await decompressXz(src, partial)
      if (written.bytes !== expectedBytes) {
        throw labError('darwin_lab_decompress_failed', 'Decompressed size differs from the xz index')
      }
      fs.renameSync(partial, path.join(dir, file))
    } catch (error) {
      fs.rmSync(partial, { force: true })
      throw error
    }
    const st = fs.statSync(path.join(dir, file))
    const manifest = {
      variant: profile.id,
      licensing: profile.licensing,
      arch: profile.arch,
      darwin_major: profile.darwinMajor,
      source: {
        url: profile.source.url,
        path: path.relative(lab.root, src),
        sha256: sourceSha,
        bytes: fs.statSync(src).size,
      },
      base: { file, format: profile.disk.format, sha256: written.sha256, bytes: st.size, mtime_ms: st.mtimeMs },
      prepared_at: new Date().toISOString(),
    }
    atomicWriteJson(manifestFile, manifest, { mode: 0o600 })
    return { reused: false, manifest }
  })
}

function instanceDir(lab, id) {
  if (!INSTANCE_ID.test(String(id || '')))
    throw labError('darwin_lab_instance_invalid', 'Instance id must match [a-z0-9-]{1,32}')
  return checkedLabPath(lab, 'instances', id)
}

function instanceRuntime(lab, id) {
  return ensurePrivateDir(path.join(lab.runtimeDir, id))
}

function readState(lab, id) {
  return readJson(path.join(instanceDir(lab, id), 'state.json'))
}

function writeState(lab, state) {
  atomicWriteJson(path.join(instanceDir(lab, state.id), 'state.json'), state, { mode: 0o600 })
}

/** Resolves binaries, private libraries and firmware strictly inside the QEMU root. */
export function resolveQemu(qemuRoot, profile) {
  if (!qemuRoot) throw labError('darwin_lab_qemu_required', '--qemu-root is required')
  let root
  try {
    root = fs.realpathSync(qemuRoot)
  } catch {
    throw labError('darwin_lab_qemu_missing', `QEMU root does not exist: ${qemuRoot}`)
  }
  if (!SAFE_PATH.test(root)) throw labError('darwin_lab_path_unsafe', `QEMU root path is unsupported: ${root}`)
  const inside = (rel, kind) => {
    const want = path.join(root, rel)
    let real
    try {
      real = fs.realpathSync(want)
    } catch {
      throw labError('darwin_lab_qemu_missing', `Missing ${kind}: ${want}`)
    }
    if (!isInside(real, root)) throw labError('darwin_lab_qemu_unsafe', `${want} resolves outside the QEMU root`)
    return real
  }
  const system = inside('usr/bin/qemu-system-x86_64', 'QEMU system emulator')
  const img = inside('usr/bin/qemu-img', 'qemu-img')
  const seabios = inside('usr/share/seabios', 'SeaBIOS firmware directory')
  const bios = inside(`usr/share/seabios/${profile.firmware}`, 'BIOS firmware')
  const firmwareDirs = [seabios]
  if (fs.existsSync(path.join(root, 'usr/share/qemu'))) firmwareDirs.push(inside('usr/share/qemu', 'QEMU data'))
  const libDirs = ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu']
    .map((rel) => path.join(root, rel))
    .filter((dir) => fs.existsSync(dir))
  // Private libraries first; anything absent falls through to the host loader path.
  const env = { PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: libDirs.join(':') }
  const modules = path.join(root, 'usr/lib/x86_64-linux-gnu/qemu')
  if (fs.existsSync(modules)) env.QEMU_MODULE_DIR = modules
  const versionOf = (bin) =>
    execFileSync(bin, ['--version'], { encoding: 'utf8', env, timeout: 10000 }).split('\n')[0].trim()
  return {
    root,
    system,
    img,
    bios,
    firmwareDirs,
    libDirs,
    env,
    version: versionOf(system),
    imgVersion: versionOf(img),
  }
}

function procStat(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ')
  return { state: rest[0], startTicks: rest[19] }
}

function bootId() {
  return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
}

function argvName(argv) {
  const at = argv.indexOf('-name')
  return at < 0 ? null : argv[at + 1]
}

/** A crash between spawn and recording the PID leaves only the unique run name to find it by. */
function findByName(name) {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (argvName(fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0')) === name) return Number(entry)
    } catch {}
  }
  return null
}

/**
 * `owned` needs the same boot, PID, start time and uid as recorded at spawn plus our
 * executable and per-run name; a reused PID is reported absent and never signalled.
 */
export function observeProcess(run) {
  if (!run?.name) return { state: 'absent', reason: 'never_started' }
  if (run.boot_id !== bootId()) return { state: 'absent', reason: 'host_rebooted' }
  const pid = run.pid ?? findByName(run.name)
  if (!pid) return { state: 'absent', reason: 'never_started' }
  let stat
  let uid
  try {
    stat = procStat(pid)
    uid = fs.statSync(`/proc/${pid}`).uid
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent', reason: 'exited' }
    return { state: 'unproven', pid, reason: error.code || 'stat_unreadable' }
  }
  if (run.pid && stat.startTicks !== run.start_ticks) return { state: 'absent', reason: 'pid_reused' }
  if (stat.state === 'Z') return { state: 'absent', reason: 'exited' }
  let exe
  let argv
  try {
    exe = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')
    argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
  } catch (error) {
    return { state: 'unproven', pid, reason: error.code || 'identity_unreadable' }
  }
  if (uid !== run.euid || exe !== run.qemu_exe || argvName(argv) !== run.name) {
    return { state: 'unproven', pid, reason: 'identity_mismatch' }
  }
  return { state: 'owned', pid, start_ticks: stat.startTicks }
}

function signalOwned(run, signal) {
  const proc = observeProcess(run)
  if (proc.state === 'owned') process.kill(proc.pid, signal)
  return proc
}

async function waitGone(run, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (observeProcess(run).state === 'absent') return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

function tail(file, bytes = LOG_TAIL_BYTES) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size
      const length = Math.min(size, bytes)
      const buf = Buffer.alloc(length)
      fs.readSync(fd, buf, 0, length, size - length)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

function hostResources(profile, memoryMiB, cpus, committedMiB) {
  const [minMem, maxMem] = profile.limits.memoryMiB
  const [minCpu, maxCpu] = profile.limits.cpus
  if (!Number.isInteger(memoryMiB) || memoryMiB < minMem || memoryMiB > maxMem) {
    throw labError('darwin_lab_resources_invalid', `memory must be an integer in [${minMem}, ${maxMem}] MiB`)
  }
  if (!Number.isInteger(cpus) || cpus < minCpu || cpus > maxCpu || cpus > os.availableParallelism()) {
    throw labError(
      'darwin_lab_resources_invalid',
      `cpus must be an integer in [${minCpu}, ${maxCpu}] and within host CPUs`,
    )
  }
  const available = Number(/^MemAvailable:\s+(\d+) kB$/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1])
  const availableMiB = Math.floor(available / 1024)
  // Other running lab guests may not have touched their RAM yet, so count it as committed.
  const needMiB = memoryMiB + committedMiB + HOST_MEMORY_RESERVE_MIB
  if (!Number.isSafeInteger(availableMiB) || availableMiB < needMiB) {
    throw labError(
      'darwin_lab_insufficient_memory',
      'Guest memory, running lab guests and host reserve exceed available memory',
      {
        need_mib: needMiB,
        committed_mib: committedMiB,
        available_mib: availableMiB,
      },
    )
  }
}

function committedMemoryMiB(lab, exceptId) {
  const root = path.join(lab.root, 'instances')
  let names
  try {
    names = fs.readdirSync(root)
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  let total = 0
  for (const name of names) {
    if (name === exceptId || !INSTANCE_ID.test(name)) continue
    const run = readJson(path.join(root, name, 'state.json'))?.run
    if (run && observeProcess(run).state !== 'absent') total += run.memory_mib
  }
  return total
}

function assertAccel(accel) {
  if (accel === 'tcg') return
  if (accel !== 'kvm') throw labError('darwin_lab_accel_invalid', 'accel must be kvm or tcg')
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK)
  } catch (error) {
    // No silent TCG fallback: an emulated run must be requested explicitly.
    throw labError('darwin_lab_kvm_inaccessible', `/dev/kvm is not accessible to uid ${process.geteuid()}`, {
      cause_code: error.code,
    })
  }
}

function readonlyPayload(lab, file) {
  if (!file) return null
  const real = fs.realpathSync(file)
  const st = fs.statSync(real)
  if (!isInside(real, lab.root) || !st.isFile()) {
    throw labError('darwin_lab_payload_unsafe', 'Payload disk must be a regular raw disk image inside the lab root')
  }
  return { file: real, bytes: st.size, sha256: sha256File(real) }
}

/** Fixed argument vector; callers choose only profile, resources and accelerator. */
function qemuArgs({ profile, qemu, base, overlay, name, qmpSocket, serialLog, memoryMiB, cpus, accel, payload }) {
  const args = ['-name', name, '-no-user-config', '-nodefaults']
  for (const dir of qemu.firmwareDirs) args.push('-L', dir)
  args.push(
    '-bios',
    qemu.bios,
    '-machine',
    profile.machine,
    '-accel',
    accel,
    '-cpu',
    profile.cpu,
    '-smp',
    String(cpus),
    '-m',
    `${memoryMiB}M`,
    '-sandbox',
    'on,obsolete=deny,elevateprivileges=deny,spawn=deny',
    '-display',
    'none',
    '-device',
    'VGA',
    '-nic',
    'none',
    '-blockdev',
    JSON.stringify({ driver: 'file', filename: base, 'node-name': 'base-file', 'read-only': true }),
    '-blockdev',
    JSON.stringify({ driver: profile.disk.format, file: 'base-file', 'node-name': 'base', 'read-only': true }),
    '-blockdev',
    JSON.stringify({ driver: 'file', filename: overlay, 'node-name': 'overlay-file' }),
    '-blockdev',
    JSON.stringify({ driver: 'qcow2', file: 'overlay-file', backing: 'base', 'node-name': 'disk0' }),
    '-device',
    'ide-hd,drive=disk0,bus=ide.0,unit=0',
    '-chardev',
    `socket,id=qmp,path=${qmpSocket},server=on,wait=off`,
    '-mon',
    'chardev=qmp,mode=control',
    '-chardev',
    `file,id=serial0,path=${serialLog}`,
    '-serial',
    'chardev:serial0',
  )
  if (payload) {
    args.push(
      '-blockdev',
      JSON.stringify({ driver: 'file', filename: payload.file, 'node-name': 'payload-file', 'read-only': true }),
      '-blockdev',
      JSON.stringify({ driver: 'raw', file: 'payload-file', 'node-name': 'payload-base', 'read-only': true }),
      '-blockdev',
      JSON.stringify({ driver: 'file', filename: payload.overlay, 'node-name': 'payload-overlay-file' }),
      '-blockdev',
      JSON.stringify({
        driver: 'qcow2',
        file: 'payload-overlay-file',
        backing: 'payload-base',
        'node-name': 'payload',
      }),
      '-device',
      'ide-hd,drive=payload,bus=ide.0,unit=1',
    )
  }
  return args
}

function createOverlay(qemu, baseFile, baseFormat, overlay) {
  const partial = `${overlay}.partial`
  fs.rmSync(partial, { force: true })
  try {
    execFileSync(qemu.img, ['create', '-q', '-f', 'qcow2', '-F', baseFormat, '-b', baseFile, partial], {
      env: qemu.env,
      timeout: 60000,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    fs.renameSync(partial, overlay)
  } catch (error) {
    fs.rmSync(partial, { force: true })
    throw labError(
      'darwin_lab_overlay_failed',
      `qemu-img create failed: ${String(error.stderr || error.message).trim()}`,
    )
  }
}

async function connectWhileAlive(child, socket, deadline) {
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) return null
    try {
      return await qmpConnect(socket, { timeoutMs: 5000 })
    } catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code) || Date.now() >= deadline) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

async function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.kill('SIGKILL')
  await exited
}

/**
 * Creates the instance overlay on first use, launches one owned QEMU generation and
 * returns only after QMP confirms the run state, guest name and requested accelerator.
 */
export async function startInstance(lab, { id, variant, qemuRoot, memoryMiB, cpus, accel = 'kvm', payloadDisk }) {
  const profile = profileFor(variant)
  const payload = readonlyPayload(lab, payloadDisk)
  const dir = instanceDir(lab, id)
  const runtime = instanceRuntime(lab, id)
  const memory = memoryMiB ?? profile.resources.memoryMiB
  const vcpus = cpus ?? profile.resources.cpus
  // The lab lease serializes memory admission across instances of this lab.
  return withLeases(lab, [`instance-${id}`, 'lab'], async () => {
    const previous = readState(lab, id)
    if (previous && previous.variant !== profile.id) {
      throw labError('darwin_lab_instance_conflict', `Instance ${id} uses ${previous.variant}`)
    }
    if (previous?.run) {
      const proc = observeProcess(previous.run)
      if (proc.state !== 'absent') {
        throw labError(
          proc.state === 'owned' ? 'darwin_lab_already_running' : 'darwin_lab_owner_unproven',
          `Instance ${id} still has a recorded QEMU process (${proc.state})`,
          { pid: proc.pid, reason: proc.reason },
        )
      }
    }
    hostResources(profile, memory, vcpus, committedMemoryMiB(lab, id))
    assertAccel(accel)
    const { manifest, file: baseFile } = readBase(lab, profile)
    if (previous && previous.base_sha256 !== manifest.base.sha256) {
      throw labError('darwin_lab_instance_conflict', `Instance ${id} overlay belongs to a different base`)
    }
    const qemu = resolveQemu(qemuRoot, profile)
    const overlay = path.join(dir, 'overlay.qcow2')
    let state = previous
    if (!state) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (fs.existsSync(overlay)) {
        throw labError('darwin_lab_instance_conflict', `Unrecorded overlay exists: ${overlay}`)
      }
      createOverlay(qemu, baseFile, profile.disk.format, overlay)
      state = {
        id,
        token: crypto.randomBytes(8).toString('hex'),
        variant: profile.id,
        licensing: profile.licensing,
        arch: profile.arch,
        base_sha256: manifest.base.sha256,
        overlay: 'overlay.qcow2',
        qemu_img: qemu.imgVersion,
        created_at: new Date().toISOString(),
        generation: 0,
        status: 'created',
        run: null,
      }
      writeState(lab, state)
    } else if (!fs.existsSync(overlay)) {
      throw labError('darwin_lab_overlay_missing', `Recorded overlay is missing: ${overlay}`)
    }

    const generation = state.generation + 1
    if (payload) {
      // IDE hard disks require writable media; isolate writes instead of making the source writable.
      payload.overlay = path.join(dir, `payload-g${generation}.qcow2`)
      createOverlay(qemu, payload.file, 'raw', payload.overlay)
    }
    const name = `kin-lab-${id}-${state.token}-g${generation}`
    const qmpSocket = path.join(runtime, 'qmp.sock')
    const serialName = `serial-g${generation}.log`
    const logName = `qemu-g${generation}.log`
    const serialLog = path.join(dir, serialName)
    try {
      if (!fs.lstatSync(qmpSocket).isSocket())
        throw labError('darwin_lab_runtime_unsafe', `${qmpSocket} is not a socket`)
      // The recorded owner is absent (checked above), so its socket is stale.
      fs.unlinkSync(qmpSocket)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const args = qemuArgs({
      profile,
      qemu,
      base: baseFile,
      overlay,
      name,
      qmpSocket,
      serialLog,
      memoryMiB: memory,
      cpus: vcpus,
      accel,
      payload,
    })
    const run = {
      generation,
      name,
      qemu_exe: qemu.system,
      qemu_root: qemu.root,
      qemu_lib_dirs: qemu.libDirs,
      qemu_bios: qemu.bios,
      qemu_version: qemu.version,
      accel,
      memory_mib: memory,
      cpus: vcpus,
      network: 'none',
      payload_disk: payload,
      qmp_socket: qmpSocket,
      serial_log: serialName,
      qemu_log: logName,
      euid: process.geteuid(),
      boot_id: bootId(),
      pid: null,
      start_ticks: null,
      started_at: new Date().toISOString(),
    }
    state = { ...state, generation, status: 'starting', run }
    writeState(lab, state)

    const logFd = fs.openSync(path.join(dir, logName), 'wx', 0o600)
    let child
    try {
      child = spawn(qemu.system, args, { detached: true, stdio: ['ignore', logFd, logFd], env: qemu.env })
    } finally {
      fs.closeSync(logFd)
    }
    const spawned = await new Promise((resolve) => {
      child.once('spawn', () => resolve(null))
      child.once('error', (error) => resolve(error))
    })
    if (spawned) {
      state = { ...state, status: 'failed', run: { ...run, error: spawned.message } }
      writeState(lab, state)
      throw labError('darwin_lab_start_failed', `QEMU did not spawn: ${spawned.message}`)
    }
    run.pid = child.pid
    try {
      run.start_ticks = procStat(child.pid).startTicks
    } catch (error) {
      await killChild(child)
      state = { ...state, status: 'failed', run: { ...run, error: 'darwin_lab_start_failed' } }
      writeState(lab, state)
      throw labError('darwin_lab_start_failed', `QEMU exited before its identity was recorded: ${error.code}`, {
        qemu_log_tail: tail(path.join(dir, logName)),
      })
    }
    writeState(lab, state)

    let qmp = null
    const fail = async (code, message, extra = {}) => {
      qmp?.close()
      await killChild(child)
      state = {
        ...state,
        status: 'failed',
        run: { ...run, error: code, stopped_at: new Date().toISOString() },
      }
      writeState(lab, state)
      return labError(code, message, { qemu_log_tail: tail(path.join(dir, logName)), ...extra })
    }
    try {
      qmp = await connectWhileAlive(child, qmpSocket, Date.now() + QMP_READY_MS)
    } catch (error) {
      throw await fail('darwin_lab_start_failed', `QMP did not become ready: ${error.message}`)
    }
    if (!qmp)
      throw await fail('darwin_lab_start_failed', `QEMU exited during startup (${child.exitCode ?? child.signalCode})`)
    try {
      const [status, guest, kvm] = await Promise.all([
        qmp.execute('query-status'),
        qmp.execute('query-name'),
        qmp.execute('query-kvm'),
      ])
      if (guest.name !== name) throw await fail('darwin_lab_owner_unproven', 'QMP answered for a different guest')
      if (accel === 'kvm' && !kvm.enabled) {
        throw await fail('darwin_lab_kvm_not_enabled', 'QEMU started without KVM acceleration', { kvm })
      }
      if (!status.running) throw await fail('darwin_lab_not_running', `QEMU is not running (${status.status})`)
      run.observed_at_start = { status: status.status, running: status.running, kvm }
    } catch (error) {
      if (String(error.code).startsWith('darwin_lab_')) throw error
      throw await fail('darwin_lab_start_failed', `QMP query failed: ${error.message}`)
    } finally {
      qmp.close()
    }
    child.unref()
    state = { ...state, status: 'running', run }
    writeState(lab, state)
    return { id, generation, pid: run.pid, observed: run.observed_at_start }
  })
}

/** Banner evidence only from this generation's serial log; older runs never count. */
export function darwinSerialEvidence(file, darwinMajor) {
  let text
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(SERIAL_SCAN_BYTES)
      text = buf.toString('latin1', 0, fs.readSync(fd, buf, 0, buf.length, 0))
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'unobserved', reason: 'no serial output' }
    throw error
  }
  const match = DARWIN_BANNER.exec(text)
  if (!match) return { state: 'unobserved', reason: 'no Darwin kernel banner on serial' }
  const evidence = { source: 'serial', file: path.basename(file), offset: match.index, line: match[0].trim() }
  if (Number(match[1]) !== darwinMajor) return { state: 'unexpected_kernel', evidence }
  return { state: 'darwin_kernel_observed', evidence }
}

/** Read-only observation; `screendump` additionally asks the owned QEMU for a PPM frame. */
export async function inspectInstance(lab, { id, screendump = false }) {
  const dir = instanceDir(lab, id)
  const state = readState(lab, id)
  if (!state) throw labError('darwin_lab_instance_missing', `Instance ${id} does not exist`)
  const profile = profileFor(state.variant)
  const run = state.run
  const proc = observeProcess(run)
  const host = { recorded_status: state.status, process: proc }
  if (proc.state === 'owned') {
    let qmp
    try {
      qmp = await qmpConnect(run.qmp_socket)
      const guest = await qmp.execute('query-name')
      if (guest.name !== run.name) {
        host.qmp = { error: 'darwin_lab_owner_unproven' }
      } else {
        const [status, kvm] = await Promise.all([qmp.execute('query-status'), qmp.execute('query-kvm')])
        host.qmp = { status: status.status, running: status.running }
        host.kvm = kvm
        if (screendump) {
          const screens = checkedLabPath(lab, 'instances', id, 'screens')
          fs.mkdirSync(screens, { recursive: true, mode: 0o700 })
          const file = path.join(screens, `g${run.generation}-${Date.now()}.ppm`)
          await qmp.execute('screendump', { filename: file })
          host.screendump = {
            file: path.relative(lab.root, file),
            sha256: sha256File(file),
            note: 'VGA frame artifact; not parsed as boot proof',
          }
        }
      }
    } catch (error) {
      host.qmp = { error: error.code || error.message }
    } finally {
      qmp?.close()
    }
  } else if (run?.qemu_log) {
    host.qemu_log_tail = tail(path.join(dir, run.qemu_log))
  }
  let overlayBytes = null
  try {
    overlayBytes = fs.statSync(path.join(dir, state.overlay)).size
  } catch {}
  return {
    id,
    variant: state.variant,
    licensing: state.licensing,
    arch: state.arch,
    base_sha256: state.base_sha256,
    overlay_bytes: overlayBytes,
    generation: state.generation,
    run: run && {
      pid: proc.pid ?? run.pid,
      qemu_exe: run.qemu_exe,
      qemu_version: run.qemu_version,
      qemu_lib_dirs: run.qemu_lib_dirs,
      qemu_bios: run.qemu_bios,
      stop_method: run.stop_method ?? null,
      error: run.error ?? null,
      accel: run.accel,
      memory_mib: run.memory_mib,
      cpus: run.cpus,
      network: run.network,
      payload_disk: run.payload_disk ?? null,
      started_at: run.started_at,
      stopped_at: run.stopped_at ?? null,
    },
    host,
    guest_os: run ? darwinSerialEvidence(path.join(dir, run.serial_log), profile.darwinMajor) : { state: 'unobserved' },
    product: {
      state: 'unproven',
      reason: 'This tool collects no authenticated guest execution result; operator experiments are separate evidence',
    },
  }
}

/**
 * Stops only a process proven to be this instance's recorded QEMU. A vanished or
 * reused PID is recorded as already stopped without signalling anything.
 */
export async function stopInstance(lab, { id, timeoutMs = STOP_TIMEOUT_MS }) {
  instanceDir(lab, id)
  return withLease(lab, `instance-${id}`, async () => {
    const state = readState(lab, id)
    if (!state) throw labError('darwin_lab_instance_missing', `Instance ${id} does not exist`)
    const recorded = state.run
    const proc = observeProcess(recorded)
    if (proc.state === 'unproven') {
      throw labError('darwin_lab_owner_unproven', `Cannot prove pid ${proc.pid} is this instance's QEMU`, {
        pid: proc.pid,
        reason: proc.reason,
      })
    }
    // A process found by its unique run name is pinned so later checks also compare start time.
    const run = proc.state === 'owned' ? { ...recorded, pid: proc.pid, start_ticks: proc.start_ticks } : recorded
    if (proc.state === 'absent') {
      if (run && !run.stopped_at) {
        writeState(lab, {
          ...state,
          status: 'stopped',
          run: { ...run, stopped_at: new Date().toISOString(), stop_method: `observed_${proc.reason}` },
        })
      }
      return { id, stopped: true, method: run?.stop_method ?? `observed_${proc.reason}` }
    }
    let method = 'qmp_quit'
    let qmp
    try {
      qmp = await qmpConnect(run.qmp_socket)
      const guest = await qmp.execute('query-name')
      if (guest.name !== run.name) {
        throw labError('darwin_lab_owner_unproven', 'QMP socket answers for a different guest; not signalling')
      }
      await qmp.execute('quit').catch((error) => {
        if (error.code !== 'qmp_closed') throw error
      })
    } catch (error) {
      if (error.code === 'darwin_lab_owner_unproven') throw error
      method = 'sigterm'
      signalOwned(run, 'SIGTERM')
    } finally {
      qmp?.close()
    }
    if (!(await waitGone(run, timeoutMs))) {
      const again = signalOwned(run, 'SIGKILL')
      if (again.state === 'unproven') {
        throw labError('darwin_lab_owner_unproven', 'Process identity changed during stop', { pid: run.pid })
      }
      method += '+sigkill'
      if (!(await waitGone(run, KILL_WAIT_MS))) {
        throw labError('darwin_lab_stop_failed', `pid ${run.pid} survived SIGKILL`, { pid: run.pid })
      }
    }
    const stoppedAt = new Date().toISOString()
    writeState(lab, { ...state, status: 'stopped', run: { ...run, stopped_at: stoppedAt, stop_method: method } })
    return { id, stopped: true, method }
  })
}

const INSTANCE_FILES = [
  /^state\.json$/,
  /^overlay\.qcow2(\.partial)?$/,
  /^payload-g\d+\.qcow2(\.partial)?$/,
  /^qemu-g\d+\.log$/,
  /^serial-g\d+\.log$/,
]
const SCREEN_FILE = /^g\d+-\d+\.ppm$/

/**
 * Removes a stopped instance. Any file the lab did not create blocks the whole destroy
 * before deletion, so nothing foreign is removed and state.json stays for a retry.
 */
export async function destroyInstance(lab, { id }) {
  const dir = instanceDir(lab, id)
  return withLease(lab, `instance-${id}`, async () => {
    const state = readState(lab, id)
    if (!state) throw labError('darwin_lab_instance_missing', `Instance ${id} does not exist`)
    const proc = observeProcess(state.run)
    if (proc.state !== 'absent') {
      throw labError('darwin_lab_instance_running', `Stop instance ${id} before destroying it (${proc.state})`)
    }
    const screens = checkedLabPath(lab, 'instances', id, 'screens')
    const names = fs.readdirSync(dir)
    const shots = names.includes('screens') ? fs.readdirSync(screens) : []
    const foreign = [
      ...names.filter((name) => name !== 'screens' && !INSTANCE_FILES.some((re) => re.test(name))),
      ...shots.filter((name) => !SCREEN_FILE.test(name)).map((name) => `screens/${name}`),
    ]
    if (foreign.length) {
      throw labError('darwin_lab_cleanup_incomplete', `Foreign files in ${dir}; nothing was removed`, { foreign })
    }
    for (const name of shots) fs.rmSync(path.join(screens, name))
    if (names.includes('screens')) fs.rmdirSync(screens)
    // state.json last, so an interrupted destroy can be resumed.
    for (const name of names) {
      if (name !== 'screens' && name !== 'state.json') fs.rmSync(path.join(dir, name))
    }
    fs.rmSync(path.join(dir, 'state.json'))
    fs.rmdirSync(dir)
    const runtime = path.join(lab.runtimeDir, id)
    try {
      const socket = path.join(runtime, 'qmp.sock')
      if (fs.lstatSync(socket).isSocket()) fs.unlinkSync(socket)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    try {
      fs.rmdirSync(runtime)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return { id, destroyed: true }
  })
}
