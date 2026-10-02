import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedVm, startGateway } from '../harness.mjs'

test('startup backfill preserves the identified Max plan in legacy slot credentials', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-plan-startup-'))
  let gw
  try {
    const vm = seedVm({ project })
    vm.claude.account_tier = 'max'
    fs.writeFileSync(path.join(project, 'vms', `${vm.id}.json`), JSON.stringify(vm))
    const file = path.join(project, 'vms', vm.id, 'cli-home', '.claude', 'credentials.json')
    const before = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(before.claudeAiOauth.subscriptionType, undefined)
    gw = await startGateway({ project })
    const after = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(after.claudeAiOauth.subscriptionType, 'max')
    assert.equal(after.claudeAiOauth.accessToken, before.claudeAiOauth.accessToken)
    assert.equal(after.claudeAiOauth.refreshToken, before.claudeAiOauth.refreshToken)
  } finally {
    await gw?.stop()
    fs.rmSync(project, { recursive: true, force: true })
  }
})
