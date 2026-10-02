import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createCliNodeGuard, selectCliNodePidsToKill } from '../../src/lib/vm/cli-node-guard.mjs'

test('guard shell only signals actual CLI executables, preserving helpers and live shells', {
  skip: process.platform !== 'linux',
}, async () => {
  // Redirect /proc reads to a fixture. Signals can only target these test children.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-proc-'))
  const children = []
  function processFixture(executable, args, panel = '') {
    const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
    children.push(child)
    const dir = path.join(root, String(child.pid))
    fs.mkdirSync(dir)
    fs.symlinkSync(executable, path.join(dir, 'exe'))
    fs.writeFileSync(path.join(dir, 'cmdline'), args.join('\0') + '\0')
    fs.writeFileSync(path.join(dir, 'environ'), panel ? `KIN_PANEL_SHELL=${panel}\0` : '')
    return child
  }
  try {
    const worker = processFixture('/slot/.kin/cli-node', ['/slot/.kin/cli-node', '-p', ''])
    const helper = processFixture('/bin/sh', ['/bin/sh', '-c', 'run cli-node -p cleanup'])
    const live = processFixture('/slot/.kin/cli-node', ['/slot/.kin/cli-node'], 'live')
    const leaked = processFixture('/slot/.kin/cli-node (deleted)', ['/slot/.kin/cli-node'], 'closed')
    let script
    const guard = createCliNodeGuard({
      listTargets: () => [{ id: 'guard-fixture' }],
      liveTokens: () => ['live'],
      exec: async (_connect, _container, args) => {
        script = args[2]
      },
    })
    await guard.tick()
    assert.ok(script)
    await promisify(execFile)('/bin/sh', ['-c', script.replaceAll('/proc/', root + '/'), 'guard', 'live'], {
      timeout: 5000,
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(worker.signalCode, null, 'primary worker survives')
    assert.equal(helper.signalCode, null, 'shell mentioning cli-node survives')
    assert.equal(live.signalCode, null, 'connected shell survives')
    assert.equal(leaked.signalCode, 'SIGKILL', 'disconnected CLI is removed')
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('keeps the oldest worker and a cli-node whose panel shell is still open', () => {
  const kill = selectCliNodePidsToKill(
    [
      { pid: 20, worker: true },
      { pid: 8, worker: true },
      { pid: 30, worker: false, panelToken: 'live' },
      { pid: 31, worker: false, panelToken: 'gone' },
      { pid: 32, worker: false, panelToken: null },
    ],
    ['live'],
  )
  assert.deepEqual(
    kill.sort((a, b) => a - b),
    [20, 31, 32],
  )
})

test('kills every interactive cli-node when no panel shell is connected', () => {
  assert.deepEqual(
    selectCliNodePidsToKill(
      [
        { pid: 4, worker: true },
        { pid: 9, worker: false, panelToken: 'stale' },
      ],
      [],
    ),
    [9],
  )
})
