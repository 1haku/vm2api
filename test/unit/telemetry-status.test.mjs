import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readSlotProcessStatus } from '../../src/lib/vm/slot-process-status.mjs'
import { buildVmDetail } from '../../src/lib/admin/panel-api.mjs'

function fixture(t, enabled) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-status-'))
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }))
  const dir = path.join(projectRoot, 'vms/vm-02/run')
  fs.mkdirSync(dir, { recursive: true })
  if (enabled !== undefined)
    fs.writeFileSync(
      path.join(dir, 'worker.json'),
      JSON.stringify({
        telemetry: { enabled, identity: { email: 'must-not-leak' } },
        credential: 'must-not-leak',
      }),
    )
  return { projectRoot, vm: { id: 'vm-02', runtime: { type: 'docker' } } }
}
const observed = 'rust_pid1=1\ngo_worker_pid1=0\ngo_telemetry=1\n'

for (const [name, argv, expected] of [
  ['native kernel', ['/home/kincli/.kin/kin-kernel', '--gateway-worker'], true],
  [
    'bundled glibc loader',
    [
      '/home/kincli/.kin/glibc239/ld-linux-x86-64.so.2',
      '--library-path',
      '/home/kincli/.kin/glibc239',
      '/home/kincli/.kin/kin-kernel.bin',
      '--gateway-worker',
    ],
    true,
  ],
  ['unrelated executable with a kernel argument', ['/bin/echo', '/home/kincli/.kin/kin-kernel'], false],
]) {
  test(`actual shell observation recognizes ${name}`, { skip: process.platform === 'win32' }, async (t) => {
    const args = fixture(t, true)
    const proc = path.join(args.projectRoot, 'proc')
    for (const [pid, command, values] of [
      ['1', 'loader', argv],
      ['10', 'kin-worker', ['/usr/local/bin/kin-worker', 'telemetry', '--config', '/run/kin/worker.json']],
    ]) {
      fs.mkdirSync(path.join(proc, pid), { recursive: true })
      fs.writeFileSync(path.join(proc, pid, 'comm'), command + '\n')
      fs.writeFileSync(path.join(proc, pid, 'cmdline'), values.join('\0') + '\0')
    }
    const result = await readSlotProcessStatus({
      ...args,
      run: async (_command, dockerArgs, options) =>
        promisify(execFile)('sh', ['-c', dockerArgs[4].replaceAll('/proc/', proc + '/')], options),
    })
    assert.equal(result.process_topology.rust_pid1, expected)
    assert.deepEqual(result.telemetry, { enabled: true, running: true })
  })
}

test('observed status reaches the public detail response without private data', async (t) => {
  const args = fixture(t, true)
  const status = await readSlotProcessStatus({
    ...args,
    run: async (cmd, argv, options) => {
      assert.equal(cmd, 'docker')
      assert.deepEqual(argv.slice(0, 4), ['exec', 'kin-02', 'sh', '-c'])
      assert.equal(options.timeout, 2500)
      return { stdout: observed }
    },
  })
  assert.deepEqual(status.telemetry, { enabled: true, running: true })
  assert.deepEqual(status.process_topology, { rust_pid1: true, go_worker_pid1: false, go_telemetry: true })
  fs.writeFileSync(
    path.join(args.projectRoot, 'vms/vm-02.json'),
    JSON.stringify({ ...args.vm, claude: {}, policy: {} }),
  )
  const detail = await buildVmDetail({
    cfg: { paths: { project: args.projectRoot }, rewrite: { enabled: false } },
    id: 'vm-02',
    accountQuota: { config: {}, snapshot: () => ({ accounts: [] }) },
    slotProcessStatus: async () => status,
  })
  assert.deepEqual(detail.data.kernel.telemetry, status.telemetry)
  assert.deepEqual(detail.data.kernel.process_topology, status.process_topology)
  assert.ok(!JSON.stringify(detail).includes('must-not-leak'))
})

test('disabled configuration is distinct from a live idle watcher', async (t) => {
  const result = await readSlotProcessStatus({ ...fixture(t, false), run: async () => ({ stdout: observed }) })
  assert.deepEqual(result.telemetry, { enabled: false, running: true })
})

test('missing configuration stays unknown even when a process exists', async (t) => {
  const result = await readSlotProcessStatus({ ...fixture(t), run: async () => ({ stdout: observed }) })
  assert.deepEqual(result.telemetry, { enabled: null, running: true })
})

test('no telemetry process is a distinct observed state', async (t) => {
  const result = await readSlotProcessStatus({
    ...fixture(t, true),
    run: async () => ({ stdout: observed.replace('go_telemetry=1', 'go_telemetry=0') }),
  })
  assert.deepEqual(result.telemetry, { enabled: true, running: false })
})

test('a stopped container or timeout reports unknown process state', async (t) => {
  const result = await readSlotProcessStatus({
    ...fixture(t, true),
    run: async () => {
      throw new Error('private docker stderr')
    },
  })
  assert.deepEqual(result, { telemetry: { enabled: true, running: null }, process_topology: null })
})

test('invalid observations cannot fabricate stopped or running status', async (t) => {
  const result = await readSlotProcessStatus({
    ...fixture(t, true),
    run: async () => ({ stdout: 'unexpected output' }),
  })
  assert.equal(result.telemetry.running, null)
  assert.equal(result.process_topology, null)
})

test('unsupported runtime and invalid slot ID do not invoke Docker', async (t) => {
  const f = fixture(t, true)
  const run = async () => assert.fail('must not invoke Docker')
  assert.equal(
    (await readSlotProcessStatus({ ...f, vm: { ...f.vm, runtime: { type: 'kvm' } }, run })).telemetry.enabled,
    true,
  )
  assert.equal((await readSlotProcessStatus({ ...f, vm: { id: '../secret' }, run })).telemetry.enabled, null)
})
