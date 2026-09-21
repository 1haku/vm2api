import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

const prevKernelBin = process.env.KIN_KERNEL_BIN

before(() => {
  delete process.env.KIN_KERNEL_BIN
})

after(() => {
  if (prevKernelBin == null) delete process.env.KIN_KERNEL_BIN
  else process.env.KIN_KERNEL_BIN = prevKernelBin
})

function seedWrapTemplate(project) {
  const template = path.join(project, 'share', 'wrap-cli')
  fs.mkdirSync(template, { recursive: true })
  fs.writeFileSync(path.join(template, 'cli-node'), 'cli-node')
  fs.writeFileSync(path.join(template, 'kin-kernel'), 'kin-kernel')
}

function fakeElf64Amd64(payload = 'uploaded-kernel') {
  const extra = Buffer.from(String(payload))
  const buf = Buffer.alloc(64 + extra.length)
  buf[0] = 0x7f
  buf[1] = 0x45
  buf[2] = 0x4c
  buf[3] = 0x46
  buf[4] = 2
  buf[5] = 1
  buf.writeUInt16LE(3, 16)
  buf.writeUInt16LE(62, 18)
  extra.copy(buf, 64)
  return buf
}

test('wrap sync updates stopped slots without requiring a kernel restart', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-wrap-sync-'))
  const response = {}
  try {
    seedWrapTemplate(project)
    const vmDir = path.join(project, 'vms')
    fs.mkdirSync(vmDir, { recursive: true })
    fs.writeFileSync(
      path.join(vmDir, 'legacy-slot.json'),
      JSON.stringify({ id: 'legacy-slot', name: 'legacy-slot', status: 'stopped' }),
    )
    const handlePanel = createPanelHandler({
      cfg: { paths: { project } },
      routingConfig: {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => ({ restart: true }),
    })

    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/sync'))

    assert.equal(response.status, 200)
    assert.equal(response.body.data.ok, true)
    assert.deepEqual(response.body.data.items[0].kernel, { ok: true, skipped: true, reason: 'vm_stopped' })
    assert.equal(
      fs.readFileSync(path.join(project, 'vms', 'legacy-slot', 'cli-home', '.kin', 'kin-kernel.bin'), 'utf8'),
      'kin-kernel',
    )
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('kernel upload replaces host and sample kernel', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-kernel-upload-'))
  const response = {}
  const elf = fakeElf64Amd64()
  try {
    seedWrapTemplate(project)
    const handlePanel = createPanelHandler({
      cfg: { paths: { project } },
      routingConfig: {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readBody: async () => ({}),
      readRawBody: async () => elf,
    })

    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/kernel'))

    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.data.ok, true)
    assert.ok(fs.readFileSync(path.join(project, 'share', 'wrap-cli', 'kin-kernel.bin')).equals(elf))
    assert.ok(fs.readFileSync(path.join(project, 'bin', 'kin-kernel')).equals(elf))
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})

test('kernel upload rejects non-ELF payloads', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-panel-kernel-bad-'))
  const response = {}
  try {
    seedWrapTemplate(project)
    const handlePanel = createPanelHandler({
      cfg: { paths: { project } },
      routingConfig: {},
      requireAuth(req) {
        req.apiKeyKind = 'master'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, payload) {
        response.status = status
        response.body = payload
        return true
      },
      readRawBody: async () => Buffer.alloc(64, 0x41),
    })

    await handlePanel({ method: 'POST' }, {}, new URL('http://localhost/api/panel/wrap-cli/kernel'))

    assert.equal(response.status, 400)
    assert.equal(response.body.error.code, 'kernel_not_elf')
  } finally {
    fs.rmSync(project, { recursive: true, force: true })
  }
})
