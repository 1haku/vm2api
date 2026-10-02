import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { panelShellLaunch } from '../../src/lib/vm/slot-shell.mjs'

test('claude in the panel shell runs cli-node, not a PATH claude', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-shell-rc-'))
  const bin = path.join(dir, 'cli-node')
  const decoyDir = path.join(dir, 'decoy')
  fs.mkdirSync(decoyDir)
  fs.writeFileSync(bin, '#!/bin/sh\necho "cli-node $*"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(decoyDir, 'claude'), '#!/bin/sh\necho DECOY\n', { mode: 0o755 })
  const { rc, cmd } = panelShellLaunch(bin)
  assert.match(cmd.at(-1), /bash --rcfile/)
  const rcPath = path.join(dir, 'rc')
  fs.writeFileSync(rcPath, `${rc}\n`)
  const ran = spawnSync('bash', ['--rcfile', rcPath, '-ic', 'type claude; claude --flag'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${decoyDir}:${process.env.PATH}`, KIN_PANEL_RCFILE: rcPath },
  })
  assert.equal(ran.status, 0, ran.stderr)
  assert.match(ran.stdout, /claude is a function/)
  assert.match(ran.stdout, /cli-node --flag/)
  assert.doesNotMatch(ran.stdout, /DECOY/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('panelShellLaunch rejects a non-absolute cli-node path', () => {
  assert.throws(() => panelShellLaunch('cli-node'), /invalid cli-node path/)
  assert.throws(() => panelShellLaunch('/tmp/a\nb'), /invalid cli-node path/)
})
