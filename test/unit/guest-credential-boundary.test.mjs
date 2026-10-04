import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  readWorkerCredentialFile,
  writeWorkerCredentialFile,
  readSlotOwnedFile,
  replaceSlotOwnedFile,
  ensureSlotSubscriptionType,
} from '../../src/lib/oauth/oauth-credentials.mjs'
import { readCodexAccounts, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'

function slot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-credential-boundary-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-alpha',
    guest_user: {
      contract: 'linux-account-v2',
      username: 'guest_alpha',
      uid: 20001,
      gid: 20001,
      home: '/home/guest_alpha',
    },
  }
  const home = path.join(root, 'vms', vm.id, 'cli-home')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(path.join(root, 'outside'))
  fs.writeFileSync(path.join(root, 'vms', `${vm.id}.json`), JSON.stringify(vm))
  return { root, home, vm, outside: path.join(root, 'outside') }
}

for (const kind of ['directory', 'file']) {
  test(`Claude ${kind} symlinks cannot read or overwrite another slot's credential`, (t) => {
    const { home, outside } = slot(t)
    const victim = path.join(outside, 'credentials.json')
    const content = JSON.stringify({
      type: 'oauth',
      claudeAiOauth: { accessToken: 'another-slot-secret', subscriptionType: 'max' },
    })
    fs.writeFileSync(victim, content, { mode: 0o640 })
    if (kind === 'directory') fs.symlinkSync(outside, path.join(home, '.claude'))
    else {
      fs.mkdirSync(path.join(home, '.claude'))
      fs.symlinkSync(victim, path.join(home, '.claude', 'credentials.json'))
    }
    const denied = { code: 'guest_ownership_failed' }
    assert.throws(() => readWorkerCredentialFile(home), denied)
    assert.throws(() => ensureSlotSubscriptionType(home, 'max'), denied)
    assert.throws(() => writeWorkerCredentialFile(home, { mode: 'apikey', api_key: 'replacement-secret' }), denied)
    assert.equal(fs.readFileSync(victim, 'utf8'), content)
    assert.equal(fs.statSync(victim).mode & 0o777, 0o640)
  })
  test(`Codex ${kind} symlinks cannot disclose or replace credentials outside HOME`, (t) => {
    const { root, home, vm, outside } = slot(t)
    const victim = path.join(outside, 'credentials.json')
    const content = JSON.stringify({ accounts: [{ access_token: 'another-slot-secret' }] })
    fs.writeFileSync(victim, content, { mode: 0o640 })
    if (kind === 'directory') fs.symlinkSync(outside, path.join(home, '.codex'))
    else {
      fs.mkdirSync(path.join(home, '.codex'))
      fs.symlinkSync(victim, path.join(home, '.codex', 'credentials.json'))
    }
    assert.throws(() => readCodexAccounts(root, vm.id), { code: 'guest_ownership_failed' })
    assert.throws(() => writeCodexAccounts(root, vm.id, [{ access_token: 'replacement-secret' }]), {
      code: 'guest_ownership_failed',
    })
    assert.equal(fs.readFileSync(victim, 'utf8'), content)
    assert.equal(fs.statSync(victim).mode & 0o777, 0o640)
  })
}

test('runtime token symlinks cannot import or replace another slot secret', (t) => {
  const { root, vm, outside } = slot(t)
  const run = path.join(root, 'vms', vm.id, 'run')
  fs.mkdirSync(run)
  const victim = path.join(outside, 'internal.token')
  fs.writeFileSync(victim, 'another-slot-secret', { mode: 0o640 })
  const token = path.join(run, 'internal.token')
  fs.symlinkSync(victim, token)
  assert.throws(() => readSlotOwnedFile(token, vm), { code: 'guest_ownership_failed' })
  assert.throws(() => replaceSlotOwnedFile(token, 'replacement-secret', vm), { code: 'guest_ownership_failed' })
  assert.equal(fs.readFileSync(victim, 'utf8'), 'another-slot-secret')
  assert.equal(fs.statSync(victim).mode & 0o777, 0o640)
})
