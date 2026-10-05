import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  darwinSerialEvidence,
  destroyInstance,
  observeProcess,
  openLab,
  startInstance,
  stopInstance,
} from '../../src/lib/vm/darwin-lab.mjs'
import { inspectMachOFile, staticDarwinVerdict } from '../../src/lib/vm/darwin-macho.mjs'

const NODE = fs.realpathSync(process.execPath)
const BOOT_ID = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()

function lab(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-darwin-lab-test-'))
  const opened = openLab({ labRoot: root, create: true })
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(opened.runtimeDir, { recursive: true, force: true })
  })
  return opened
}

function startTicks(pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19]
}

/** A real process whose argv carries `-name <name>` like a launched guest; optionally ignores SIGTERM. */
async function guestLike(t, name, { ignoreTerm = false } = {}) {
  // Report readiness only after the SIGTERM handler exists, so the test never races node startup.
  const code = `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}process.stdout.write('r');setInterval(()=>{},1e6)`
  const child = spawn(process.execPath, ['-e', code, '--', '-name', name], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
  })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  return { child, exited }
}

function writeInstance(lab, id, run) {
  const dir = path.join(lab.root, 'instances', id)
  fs.mkdirSync(dir, { recursive: true })
  const state = {
    id,
    token: 'feedfacecafebeef',
    variant: 'puredarwin-17.4',
    licensing: 'open-source',
    arch: 'x86_64',
    base_sha256: 'a'.repeat(64),
    overlay: 'overlay.qcow2',
    generation: run ? run.generation : 0,
    status: run ? 'running' : 'created',
    run,
  }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
  fs.writeFileSync(path.join(dir, 'overlay.qcow2'), 'overlay')
  return dir
}

function runFor(lab, id, pid, name, extra = {}) {
  return {
    generation: 1,
    name,
    qemu_exe: NODE,
    qmp_socket: path.join(lab.runtimeDir, id, 'qmp.sock'),
    serial_log: 'serial-g1.log',
    qemu_log: 'qemu-g1.log',
    memory_mib: 1024,
    euid: process.geteuid(),
    boot_id: BOOT_ID,
    pid,
    start_ticks: pid ? startTicks(pid) : null,
    ...extra,
  }
}

const alive = (child) => child.exitCode === null && child.signalCode === null

test('stop never signals a recorded PID whose executable or run name differs', async (t) => {
  const l = lab(t)
  const { child } = await guestLike(t, 'someone-else')
  writeInstance(l, 'vm1', runFor(l, 'vm1', child.pid, 'kin-lab-vm1-feedfacecafebeef-g1'))
  await assert.rejects(stopInstance(l, { id: 'vm1', timeoutMs: 500 }), { code: 'darwin_lab_owner_unproven' })
  await assert.rejects(destroyInstance(l, { id: 'vm1' }), { code: 'darwin_lab_instance_running' })
  assert.ok(alive(child))
  assert.ok(fs.existsSync(path.join(l.root, 'instances/vm1/overlay.qcow2')))
})

test('a reused PID is recorded as stopped without being signalled', async (t) => {
  const l = lab(t)
  const name = 'kin-lab-vm1-feedfacecafebeef-g1'
  const { child } = await guestLike(t, name)
  writeInstance(l, 'vm1', runFor(l, 'vm1', child.pid, name, { start_ticks: '1' }))
  const out = await stopInstance(l, { id: 'vm1', timeoutMs: 500 })
  assert.equal(out.method, 'observed_pid_reused')
  assert.ok(alive(child))
  const state = JSON.parse(fs.readFileSync(path.join(l.root, 'instances/vm1/state.json'), 'utf8'))
  assert.equal(state.status, 'stopped')
})

test('a process lost before its PID was recorded is found by run name and stopped', async (t) => {
  const l = lab(t)
  const name = `kin-lab-vm1-${process.pid}-g1`
  const { child, exited } = await guestLike(t, name)
  writeInstance(l, 'vm1', runFor(l, 'vm1', null, name))
  assert.equal(observeProcess(runFor(l, 'vm1', null, name)).pid, child.pid)
  const out = await stopInstance(l, { id: 'vm1', timeoutMs: 5000 })
  assert.equal(out.method, 'sigterm')
  await exited
})

test('concurrent stop of one instance is refused while the first escalates to SIGKILL', async (t) => {
  const l = lab(t)
  const name = `kin-lab-vm1-${process.pid}-g1`
  const { child, exited } = await guestLike(t, name, { ignoreTerm: true })
  writeInstance(l, 'vm1', runFor(l, 'vm1', child.pid, name))
  const first = stopInstance(l, { id: 'vm1', timeoutMs: 800 })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await assert.rejects(stopInstance(l, { id: 'vm1', timeoutMs: 800 }), { code: 'darwin_lab_busy' })
  assert.equal((await first).method, 'sigterm+sigkill')
  assert.equal(await exited, null)
  assert.equal(child.signalCode, 'SIGKILL')
  const again = await stopInstance(l, { id: 'vm1' })
  assert.equal(again.method, 'sigterm+sigkill')
})

test('destroy refuses foreign files before removing anything and then removes only lab files', async (t) => {
  const l = lab(t)
  const dir = writeInstance(l, 'vm1', null)
  fs.writeFileSync(path.join(dir, 'user-disk.img'), 'keep')
  await assert.rejects(destroyInstance(l, { id: 'vm1' }), (error) => {
    assert.equal(error.code, 'darwin_lab_cleanup_incomplete')
    assert.deepEqual(error.foreign, ['user-disk.img'])
    return true
  })
  assert.ok(fs.existsSync(path.join(dir, 'overlay.qcow2')))
  assert.ok(fs.existsSync(path.join(dir, 'state.json')))
  fs.rmSync(path.join(dir, 'user-disk.img'))
  assert.deepEqual(await destroyInstance(l, { id: 'vm1' }), { id: 'vm1', destroyed: true })
  assert.equal(fs.existsSync(dir), false)
})

test('copied lab markers and a different operator cannot borrow the original lease scope', (t) => {
  const l = lab(t)
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-darwin-lab-copy-'))
  t.after(() => fs.rmSync(other, { recursive: true, force: true }))
  const markerFile = path.join(l.root, 'darwin-lab.json')
  fs.copyFileSync(markerFile, path.join(other, 'darwin-lab.json'))
  assert.throws(() => openLab({ labRoot: other }), { code: 'darwin_lab_owner_unproven' })
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'))
  fs.writeFileSync(markerFile, JSON.stringify({ ...marker, owner_uid: marker.owner_uid + 1 }))
  assert.throws(() => openLab({ labRoot: l.root }), { code: 'darwin_lab_owner_unproven' })
})

test('destroy rejects linked instance storage and preserves the external overlay and state', async (t) => {
  const l = lab(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-darwin-lab-foreign-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const foreign = path.join(outside, 'vm1')
  fs.mkdirSync(foreign)
  const state = JSON.stringify({ id: 'vm1', run: null })
  fs.writeFileSync(path.join(foreign, 'state.json'), state)
  fs.writeFileSync(path.join(foreign, 'overlay.qcow2'), 'foreign-disk')
  fs.symlinkSync(outside, path.join(l.root, 'instances'))
  await assert.rejects(destroyInstance(l, { id: 'vm1' }), { code: 'darwin_lab_path_unsafe' })
  assert.equal(fs.readFileSync(path.join(foreign, 'state.json'), 'utf8'), state)
  assert.equal(fs.readFileSync(path.join(foreign, 'overlay.qcow2'), 'utf8'), 'foreign-disk')
})

test('payload media outside the lab, including an escaping symlink, cannot reach QEMU startup', async (t) => {
  const l = lab(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-darwin-lab-media-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const file = path.join(outside, 'foreign.hfs')
  fs.writeFileSync(file, 'foreign-medium')
  const link = path.join(l.root, 'payload.hfs')
  fs.symlinkSync(file, link)
  for (const payloadDisk of [file, link, l.root]) {
    await assert.rejects(startInstance(l, { id: 'vm1', variant: 'puredarwin-17.4', payloadDisk }), {
      code: 'darwin_lab_payload_unsafe',
    })
  }
  assert.equal(fs.existsSync(path.join(l.root, 'instances')), false)
  assert.equal(fs.readFileSync(file, 'utf8'), 'foreign-medium')
})

test('licensed macOS variants are refused before any lab state is created', async (t) => {
  const l = lab(t)
  await assert.rejects(startInstance(l, { id: 'vm1', variant: 'macos-15', qemuRoot: '/nonexistent' }), {
    code: 'macos_license_review_required',
  })
  assert.equal(fs.existsSync(path.join(l.root, 'instances')), false)
})

test('guest OS evidence requires the profile Darwin kernel banner on serial', (t) => {
  const l = lab(t)
  const file = path.join(l.root, 'serial-g1.log')
  assert.equal(darwinSerialEvidence(file, 17).state, 'unobserved')
  fs.writeFileSync(file, 'BIOS\r\nLoading kernel...\r\n')
  assert.equal(darwinSerialEvidence(file, 17).state, 'unobserved')
  fs.appendFileSync(file, 'Darwin Kernel Version 18.2.0: Mon Nov 12; root:xnu-4903\r\n')
  assert.equal(darwinSerialEvidence(file, 17).state, 'unexpected_kernel')
  fs.writeFileSync(file, 'Darwin Kernel Version 17.4.0: Sun Dec 17; root:xnu-4570.41.2~1/RELEASE_X86_64\r\n')
  const seen = darwinSerialEvidence(file, 17)
  assert.equal(seen.state, 'darwin_kernel_observed')
  assert.match(seen.evidence.line, /^Darwin Kernel Version 17\.4\.0/)
})

/** Minimal x86_64 MH_EXECUTE with LC_BUILD_VERSION(minos) and one LC_LOAD_DYLIB. */
function machO(minos, { cpu = 0x01000007 } = {}) {
  const dylibName = Buffer.from('/usr/lib/libSystem.B.dylib\0\0\0\0\0\0')
  const build = Buffer.alloc(24)
  build.writeUInt32LE(0x32, 0)
  build.writeUInt32LE(24, 4)
  build.writeUInt32LE(1, 8)
  build.writeUInt32LE(minos, 12)
  build.writeUInt32LE(minos, 16)
  const dylib = Buffer.alloc(24 + dylibName.length)
  dylib.writeUInt32LE(0xc, 0)
  dylib.writeUInt32LE(dylib.length, 4)
  dylib.writeUInt32LE(24, 8)
  dylib.writeUInt32LE(0x10000, 20)
  dylibName.copy(dylib, 24)
  const header = Buffer.alloc(32)
  header.writeUInt32LE(0xfeedfacf, 0)
  header.writeUInt32LE(cpu, 4)
  header.writeUInt32LE(2, 12)
  header.writeUInt32LE(2, 16)
  header.writeUInt32LE(build.length + dylib.length, 20)
  return Buffer.concat([header, build, dylib])
}

test('static Mach-O verdict excludes binaries whose deployment target exceeds the guest kernel', (t) => {
  const l = lab(t)
  const file = path.join(l.root, 'bin')
  const check = (bytes) => {
    fs.writeFileSync(file, bytes)
    return staticDarwinVerdict(inspectMachOFile(file), 17)
  }
  fs.writeFileSync(file, machO(0x0a0d00))
  const info = inspectMachOFile(file)
  assert.equal(info.minos, '10.13.0')
  assert.deepEqual(info.dylibs, [{ kind: 'load', name: '/usr/lib/libSystem.B.dylib', compatibility: '1.0.0' }])
  assert.equal(check(machO(0x0a0d00)).verdict, 'not_excluded')
  const newer = check(machO(0x0a0e00))
  assert.equal(newer.verdict, 'incompatible')
  assert.equal(newer.required_darwin, 18)
  assert.equal(check(machO(0x0d0000)).required_darwin, 22)
  assert.equal(check(machO(0x0a0d00, { cpu: 0x0100000c })).verdict, 'incompatible')
  assert.equal(check(Buffer.from('\x7fELF' + '\0'.repeat(60), 'latin1')).verdict, 'incompatible')
})
