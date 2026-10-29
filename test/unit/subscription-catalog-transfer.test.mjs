import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { PanelUserStore as PanelUsers } from '../../src/lib/admin/panel-users.mjs'
import { SubscriptionsRepo } from '../../src/lib/db/repos/subscriptions-repo.mjs'
import { ImagePermissionsRepo } from '../../src/lib/db/repos/image-permissions-repo.mjs'
import { exportCatalog, importCatalog } from '../../scripts/subscription-catalog-transfer.mjs'

test('catalog copy preserves login, user limits and plan terms without carrying slots, keys or assignments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-transfer-'))
  const source = createDatabase({ dbPath: path.join(dir, 'source.db') })
  const target = createDatabase({ dbPath: path.join(dir, 'target.db') })
  t.after(() => {
    source.close()
    target.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const users = new PanelUsers({ db: source })
  const admin = users.create({
    username: 'admin',
    password: 'fixture-admin-password',
    role: 'admin',
    concurrency: 0,
    rpm_limit: 0,
  })
  const member = users.create({ username: 'member', password: 'fixture-member-password', concurrency: 8, rpm_limit: 0 })
  new ImagePermissionsRepo(source).save(admin.id, true)
  source
    .prepare('INSERT INTO vms(id,vm_json) VALUES(?,?)')
    .run('old-slot', JSON.stringify({ id: 'old-slot', secret: 'NEVER_COPY_SLOT_SECRET' }))
  const repo = new SubscriptionsRepo(source)
  const plan = repo.savePlan(
    {
      name: 'Claude Max',
      vm_ids: ['old-slot'],
      daily_limit_usd: 150,
      weekly_limit_usd: 400,
      rate_multiplier: 2,
      subscription_concurrency: 4,
      group_rpm_limit: 60,
      user_rpm_limit: 20,
    },
    admin.id,
  )
  repo.assign({ group_id: plan.id, user_ids: [member.id] }, admin.id)
  source
    .prepare('INSERT INTO api_keys(id,key,name,user_id,group_id) VALUES(?,?,?,?,?)')
    .run('old-key', 'NEVER_COPY_API_KEY', 'private-key', member.id, plan.id)
  const catalog = exportCatalog(source)
  assert.ok(!JSON.stringify(catalog).includes('NEVER_COPY'))
  const result = importCatalog(target, catalog)
  assert.equal(result.slots, 0)
  assert.equal(result.memberships, 0)
  const importedUsers = new PanelUsers({ db: target })
  assert.equal(importedUsers.authenticate('admin', 'fixture-admin-password').id, admin.id)
  assert.equal(importedUsers.authenticate('member', 'fixture-member-password').id, member.id)
  assert.equal(importedUsers.getById(member.id).concurrency, 8)
  assert.equal(importedUsers.getById(member.id).rpm_limit, 0)
  assert.equal(importedUsers.getById(admin.id).image_generation_enabled, true)
  assert.equal(importedUsers.getById(member.id).image_generation_enabled, false)
  const copied = new SubscriptionsRepo(target).plans()[0]
  assert.equal(copied.status, 'disabled')
  assert.deepEqual(copied.vm_ids, [])
  assert.equal(copied.members, 0)
  assert.equal(copied.weekly_reset_mode, 'independent')
  for (const field of [
    'daily_limit_usd',
    'weekly_limit_usd',
    'rate_multiplier',
    'subscription_concurrency',
    'group_rpm_limit',
    'user_rpm_limit',
  ])
    assert.equal(copied[field], plan[field])
  for (const table of [
    'vms',
    'accounts',
    'api_keys',
    'custom_user_subscriptions',
    'custom_subscription_ledger',
    'usage_logs',
  ])
    assert.equal(target.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0)
  assert.throws(() => importCatalog(target, catalog), /Destination is not empty/)
})

test('invalid plan rolls back imported users and does not alter the source', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-rollback-'))
  const source = createDatabase({ dbPath: path.join(dir, 'source.db') })
  const target = createDatabase({ dbPath: path.join(dir, 'target.db') })
  t.after(() => {
    source.close()
    target.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  new PanelUsers({ db: source }).create({ username: 'admin', password: 'fixture-admin-password', role: 'admin' })
  const catalog = exportCatalog(source)
  catalog.plans.push({ name: '', platform: 'claude' })
  assert.throws(() => importCatalog(target, catalog))
  assert.equal(target.prepare('SELECT COUNT(*) n FROM users').get().n, 0)
  assert.equal(source.prepare('SELECT COUNT(*) n FROM users').get().n, 1)
})
