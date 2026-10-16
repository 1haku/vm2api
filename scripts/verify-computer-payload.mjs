// Exercise the official binary against disposable identities, never production slots.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { computerBin, ensureSlotComputer } from '../src/lib/identity/slot-computer.mjs'

const root = path.resolve(import.meta.dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'deploy/computer-payload.json'), 'utf8'))
const entry = manifest.files[0]
if (process.argv.includes('--image')) process.env.KIN_COMPUTER_BIN = path.join(root, 'image-bin/kin-computer')
const binary = computerBin()
const bytes = fs.readFileSync(binary)
assert.equal(bytes.length, entry.size)
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256)
fs.accessSync(binary, fs.constants.X_OK)
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-computer-check-'))
try {
  for (const runtime of ['docker', 'kvm']) {
    const vm = { id: `verify-${runtime}`, kernel: 'ubuntu-24.04', runtime: { type: runtime } }
    const first = ensureSlotComputer(project, vm)
    assert.equal(first.created, true)
    const again = ensureSlotComputer(project, vm)
    assert.equal(again.created, false)
    assert.equal(again.hostname, first.hostname)
    assert.equal(again.guest_machine_id, first.guest_machine_id)
    if (runtime === 'docker') {
      assert.match(first.mac, /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)
      assert.ok(fs.existsSync(path.join(first.dir, 'system/etc/kin-computer')))
      assert.ok(fs.readdirSync(path.join(first.dir, 'system/dmi/id')).length)
    } else assert.ok(fs.statSync(path.join(first.dir, 'qemu-smbios.args')).size)
    console.log(JSON.stringify({ runtime, officialBinary: true, identityCreated: true, repeatStable: true }))
  }
} finally {
  fs.rmSync(project, { recursive: true, force: true })
}
