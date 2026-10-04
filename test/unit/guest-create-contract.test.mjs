import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { retireGuestAllocation } from '../../src/lib/vm/guest-account.mjs'

const exec = promisify(execFile)
const routeUrl = new URL('../../src/lib/admin/panel-routes.mjs', import.meta.url).href
const endpoint = new URL('http://localhost/api/panel/vms/create')

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-create-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

async function create(root, body, key) {
  const response = {}
  const handler = createPanelHandler({
    cfg: { paths: { project: root } },
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    readBody: async () => body,
    json(_res, status, value) {
      response.status = status
      response.body = value
      return true
    },
    proxyPool: {
      allocateForVm() {
        throw new Error('unexpected allocation')
      },
      getProxyForVm() {
        return null
      },
    },
  })
  await handler({ method: 'POST', headers: key ? { 'idempotency-key': key } : {} }, {}, endpoint)
  return response
}

const desired = {
  id: 'vm-shared',
  guest_os: { id: 'fedora-44', arch: 'x86_64' },
  username: 'guest_alpha',
  start: false,
  auto_allocate_proxy: false,
}

test('invalid OS, runtime, username and unavailable destinations fail before persistence', async (t) => {
  const root = project(t)
  const cases = [
    [{ kernel: 'unknown-os' }, 400, 'unknown_os'],
    [{ kernel: 'ubuntu-24.04', runtime: { type: 'unknown' } }, 400, 'unknown_runtime'],
    [{ kernel: 'debian-13', guest_os: { id: 'fedora-44' } }, 400, 'os_fields_conflict'],
    [
      { guest_os: { id: 'macos-15' }, runtime: { type: 'kvm', provider: 'docker-qemu' } },
      409,
      'macos_license_review_required',
    ],
    [{ guest_os: { id: 'fedora-44' }, node_id: 'remote-node' }, 409, 'remote_unsupported'],
    [{ guest_os: { id: 'fedora-44' }, username: '../escape' }, 400, 'guest_user_conflict'],
  ]
  for (const [input, status, code] of cases) {
    const result = await create(root, { ...input, start: false, auto_allocate_proxy: false })
    assert.equal(result.status, status)
    assert.equal(result.body.error.code, code)
    assert.deepEqual(fs.readdirSync(root), [])
  }
})

test('requested running status cannot publish an unstarted candidate as running', async (t) => {
  const root = project(t)
  const result = await create(root, { ...desired, status: 'running' }, 'unstarted-key')
  assert.equal(result.status, 200)
  const vm = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${desired.id}.json`), 'utf8'))
  assert.equal(vm.status, 'stopped')
  assert.equal(vm.provisioning.state, 'planned')
  assert.equal(vm.schedulable, false)
})

test('same operation reuses the VM while changed specification conflicts without rotating its identity', async (t) => {
  const root = project(t)
  assert.equal((await create(root, desired, 'stable-key')).status, 200)
  const file = path.join(root, 'vms', `${desired.id}.json`)
  const first = fs.readFileSync(file, 'utf8')
  const retry = await create(root, desired, 'stable-key')
  assert.equal(retry.status, 200)
  assert.equal(retry.body.data.reused, true)
  assert.equal((await create(root, { ...desired, username: 'guest_beta' }, 'stable-key')).status, 409)
  assert.equal(fs.readFileSync(file, 'utf8'), first)
})

test('multiple gateway processes publish one generation and nonce for an idempotent create', async (t) => {
  const root = project(t)
  const source = `import fs from 'node:fs'; import {createPanelHandler} from ${JSON.stringify(routeUrl)}; const root=${JSON.stringify(root)}; let response; const handler=createPanelHandler({cfg:{paths:{project:root}},requireAuth(req){req.apiKeyKind='master';req.panelRole='admin';return true},readBody:async()=>(${JSON.stringify(desired)}),json(res,status,body){response={status,body};return true},proxyPool:{allocateForVm(){throw Error('unexpected allocation')},getProxyForVm(){return null}}}); await handler({method:'POST',headers:{'idempotency-key':'concurrent-key'}},{},new URL('http://localhost/api/panel/vms/create')); if(response.status!==200) process.stdout.write(JSON.stringify(response)); else {const vm=JSON.parse(fs.readFileSync(root+'/vms/vm-shared.json','utf8')); process.stdout.write(JSON.stringify({status:response.status,account:vm.guest_user,operation:vm.provisioning.operation_id,generation:vm.provisioning.generation,nonce:vm.provisioning.nonce}));}`
  const results = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', source], {
        timeout: 30000,
        maxBuffer: 65536,
      })
      return JSON.parse(stdout)
    }),
  )
  for (const result of results) {
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.generation, 1)
    assert.deepEqual(result, results[0])
  }
})

test('legacy creates cannot acquire a UID already reserved by a new account', async (t) => {
  const root = project(t)
  await create(root, desired, 'v2-key')
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'vms', `${desired.id}.json`), 'utf8'))
  const legacyId = `vm-${saved.guest_user.uid - Number(process.env.KIN_VM_UID_BASE || 10000)}`
  const result = await create(root, { id: legacyId, kernel: 'ubuntu-24.04', start: false, auto_allocate_proxy: false })
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'guest_user_conflict')
  assert.equal(fs.existsSync(path.join(root, 'vms', `${legacyId}.json`)), false)
})

test('deleted operations cannot republish a guest from a retained reservation', async (t) => {
  const root = project(t)
  await create(root, desired, 'retired-key')
  const file = path.join(root, 'vms', `${desired.id}.json`)
  retireGuestAllocation(root, JSON.parse(fs.readFileSync(file, 'utf8')))
  fs.unlinkSync(file)
  const result = await create(root, desired, 'retired-key')
  assert.equal(result.status, 409)
  assert.equal(result.body.error.code, 'idempotency_conflict')
  assert.equal(fs.existsSync(file), false)
})
