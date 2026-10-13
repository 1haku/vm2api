import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AccountsRepo } from '../../src/lib/db/repos/accounts-repo.mjs'
import { startGateway, api } from '../harness.mjs'

test('official weekly plan is configurable by admins only and user views hide the reference identity', async () => {
  const gw = await startGateway()
  let db
  try {
    const vm = JSON.parse(fs.readFileSync(path.join(gw.project, 'vms', 'vm-sim-01.json'), 'utf8'))
    db = new DatabaseSync(path.join(gw.project, 'data', 'kin.db'))
    db.exec('PRAGMA busy_timeout=5000')
    const accounts = new AccountsRepo(db),
      id = vm.claude.account_uuid
    const account = accounts.get(id) || accounts.insert({ account_id: id, vm_id: vm.id })
    const end = new Date(Date.now() + 86400000).toISOString()
    account.unified = { headers: { '7d': { reset: end, utilization: 0.7 } } }
    accounts.save(account)
    const created = await api(gw, 'POST', '/api/panel/users', {
      body: { username: 'weekly-user', password: 'weekly-test-pass', role: 'user' },
    })
    const user = created.json.data.item.id
    const provision = await api(gw, 'POST', '/api/panel/subscriptions/provision', {
      body: {
        plan: {
          name: 'Official week',
          platform: 'claude',
          vm_ids: [vm.id],
          weekly_limit_usd: 100,
          weekly_reset_mode: 'slot',
          weekly_reset_vm_id: vm.id,
        },
        user_ids: [user],
      },
    })
    assert.equal(provision.status, 200, provision.text)
    const plan = provision.json.data.plan
    const login = await api(gw, 'POST', '/api/panel/login', {
      body: { username: 'weekly-user', password: 'weekly-test-pass' },
    })
    const headers = { authorization: 'Bearer ' + login.json.token }
    const own = await api(gw, 'GET', '/api/panel/subscriptions', { headers })
    assert.equal(own.status, 200)
    assert.equal(own.json.data.items.length, 1)
    const sub = own.json.data.items[0]
    assert.equal(sub.weekly_reset_at, end)
    assert.equal(sub.weekly_sync_status, 'synced')
    for (const field of ['weekly_reset_vm_id', 'weekly_source_account', 'weekly_window_start', 'weekly_window_end'])
      assert.equal(sub[field], undefined, field)
    const denied = await api(gw, 'PATCH', '/api/panel/subscription-plans/' + plan.id, {
      headers,
      body: { weekly_reset_mode: 'independent' },
    })
    assert.equal(denied.status, 403)
    const reset = await api(gw, 'PATCH', '/api/panel/subscriptions/' + sub.id, { body: { action: 'reset' } })
    assert.equal(reset.status, 200)
    assert.equal(reset.json.data.weekly_reset_at, end)
    const bad = await api(gw, 'PATCH', '/api/panel/subscription-plans/' + plan.id, {
      body: { weekly_reset_vm_id: 'unbound' },
    })
    assert.equal(bad.status, 400)
  } finally {
    db?.close()
    await gw.stop()
  }
})
