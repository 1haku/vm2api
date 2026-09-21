import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'

function seedWrapTemplate(project) {
  const template = path.join(project, 'share', 'wrap-cli')
  fs.mkdirSync(template, { recursive: true })
  fs.writeFileSync(path.join(template, 'cli-node'), 'cli-node')
  fs.writeFileSync(path.join(template, 'kin-kernel'), 'kin-kernel')
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
