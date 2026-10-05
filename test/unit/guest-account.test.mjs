import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { allocateGuestAccount, findGuestAllocation, guestAccount } from '../../src/lib/vm/guest-account.mjs'

const exec = promisify(execFile)
const moduleUrl = new URL('../../src/lib/vm/guest-account.mjs', import.meta.url).href

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-guest-account-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function allocate(root, id, operationId = id, specHash = 'spec-one', username) {
  return allocateGuestAccount(root, id, { operationId, specHash, username })
}

async function childAllocation(root, id, operationId = id) {
  const source = `import { allocateGuestAccount } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(allocateGuestAccount(${JSON.stringify(root)}, ${JSON.stringify(id)}, { operationId: ${JSON.stringify(operationId)}, specHash: 'spec-one' })))`
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', source], {
    timeout: 30000,
    maxBuffer: 65536,
  })
  return JSON.parse(stdout)
}

test('invalid usernames and unsafe VM IDs leave the project untouched', (t) => {
  const root = project(t)
  for (const username of ['', 'root/name', 'GuestName', '../guest', 'ab', 'x'.repeat(25)]) {
    assert.throws(() => allocate(root, 'vm-invalid', 'operation', 'spec', username), { code: 'guest_user_conflict' })
  }
  assert.throws(() => allocate(root, '../escape'), { code: 'guest_user_conflict' })
  assert.deepEqual(fs.readdirSync(root), [])
})

test('retry and database reopen preserve the entire identity; conflicting requests do not replace it', (t) => {
  const root = project(t)
  const first = allocate(root, 'vm-retry', 'stable-operation', 'spec-one', 'guest_alpha')
  assert.deepEqual(allocate(root, 'vm-retry', 'stable-operation', 'spec-one', 'guest_alpha'), first)
  assert.deepEqual(findGuestAllocation(root, 'stable-operation'), first)
  assert.throws(() => allocate(root, 'vm-retry', 'stable-operation', 'spec-two', 'guest_alpha'), {
    code: 'idempotency_conflict',
  })
  assert.throws(() => allocate(root, 'vm-other', 'other-operation', 'spec-one', 'guest_alpha'), {
    code: 'guest_user_conflict',
  })
  assert.deepEqual(findGuestAllocation(root, 'stable-operation'), first)
  assert.equal(findGuestAllocation(root, 'other-operation'), null)
})

test('independent controller processes allocate unique identities and nonnumeric IDs retain their own execution UID', async (t) => {
  const root = project(t)
  allocate(root, 'vm-seed')
  const accounts = await Promise.all(
    Array.from({ length: 12 }, (_, i) => childAllocation(root, `vm-named-${String.fromCharCode(97 + i)}`)),
  )
  for (const field of ['username', 'uid', 'hostname', 'uuid', 'mac', 'machine_id']) {
    assert.equal(
      new Set(accounts.map((account) => account[field])).size,
      accounts.length,
      `${field} is unique across processes`,
    )
  }
  for (const account of accounts) {
    const execution = guestAccount({ id: account.vm_id, guest_user: account })
    assert.equal(execution.uid, account.uid)
    assert.equal(execution.gid, account.uid)
    assert.equal(execution.home, `/home/${account.username}`)
    assert.deepEqual(findGuestAllocation(root, account.operation_id), account)
  }
})

test('simultaneous retries from multiple processes converge on one persistent identity', async (t) => {
  const root = project(t)
  allocate(root, 'vm-seed')
  const results = await Promise.all(
    Array.from({ length: 8 }, () => childAllocation(root, 'vm-shared', 'one-operation')),
  )
  for (const result of results) assert.deepEqual(result, results[0])
  assert.deepEqual(findGuestAllocation(root, 'one-operation'), results[0])
})

test('a fully reserved legacy UID range cannot be assigned to a new account', (t) => {
  const root = project(t)
  const legacyUids = Array.from({ length: 40000 }, (_, index) => index + 20000)
  assert.throws(
    () =>
      allocateGuestAccount(root, 'vm-reserved', { operationId: 'reserved-operation', specHash: 'spec', legacyUids }),
    { code: 'guest_user_conflict' },
  )
  assert.equal(findGuestAllocation(root, 'reserved-operation'), null)
})
