import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase, withTransaction } from '../../src/lib/db/database.mjs'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { PanelUserStore } from '../../src/lib/admin/panel-users.mjs'
import { RequestLimitsRepo } from '../../src/lib/db/repos/request-limits-repo.mjs'

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-limits-'))
  const db = createDatabase({ dataDir: dir })
  t.after(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const users = new PanelUserStore({ db }),
    limits = new RequestLimitsRepo(db),
    keys = new ApiKeyStore({ db })
  const a = users.create({ username: 'user-a', password: 'test-password', concurrency: 2, rpm_limit: 0 })
  const b = users.create({ username: 'user-b', password: 'test-password', concurrency: 2, rpm_limit: 0 })
  db.exec(
    "INSERT INTO groups(id,name) VALUES(9,'limit-group'),(10,'other-limit-group'); INSERT INTO custom_subscription_plans(group_id) VALUES(9),(10)",
  )
  const key = (user = a, group = 9, extra = {}) =>
    keys.create({ name: 'test', user_id: user.id, group_id: group, max_concurrency: 0, rpm: 0, ...extra })
  return { db, users, limits, keys, a, b, key }
}

test('user concurrency aggregates all keys and keeps original claims through transfer, deletion and repeated release', (t) => {
  const { db, users, keys, a, b, key } = fixture(t)
  const one = key(),
    two = key(a, 10),
    three = key(),
    other = key(b)
  const lease1 = keys.acquire(one),
    lease2 = keys.acquire(two)
  assert.equal(lease1.ok, true)
  assert.equal(lease2.ok, true)
  assert.equal(keys.acquire(three).code, 'user_concurrency_limit')
  db.prepare('UPDATE api_keys SET user_id=? WHERE id=?').run(b.id, one.id)
  keys.remove(two.id)
  assert.equal(keys.acquire(three).code, 'user_concurrency_limit')
  const otherLease = keys.acquire(other)
  assert.equal(otherLease.ok, true)
  users.update(a.id, { concurrency: 1 })
  lease1.release()
  lease1.release()
  assert.equal(keys.acquire(three).code, 'user_concurrency_limit')
  lease2.release()
  const next = keys.acquire(three)
  assert.equal(next.ok, true)
  next.release()
  otherLease.release()
  assert.equal(keys.userInflight.size, 0)
  assert.equal(keys.inflight.size, 0)
})

test('global user RPM survives fresh stores, key rotation/deletion and crosses groups; rolling window boundary is exact', (t) => {
  const { db, users, keys, a, b, key } = fixture(t)
  users.update(a.id, { rpm_limit: 2 })
  const one = key(),
    two = key(a, 10),
    other = key(b),
    now = 100000
  keys.acquire(one, now).release()
  keys.acquire(two, now + 1000).release()
  keys.rotate(one.id)
  keys.remove(two.id)
  const newStore = new ApiKeyStore({ db }),
    third = key()
  const blocked = newStore.acquire(third, now + 2000)
  assert.equal(blocked.code, 'user_rpm_limit')
  assert.equal(blocked.retry_after, 58)
  users.update(a.id, { rpm_limit: 1 })
  assert.equal(newStore.acquire(third, now + 2000).retry_after, 59, 'lowered cap waits until enough old starts expire')
  users.update(a.id, { rpm_limit: 2 })
  assert.equal(newStore.acquire(third, now + 59999).ok, false)
  const next = newStore.acquire(third, now + 60000)
  assert.equal(next.ok, true)
  next.release()
  const otherLease = newStore.acquire(other, now + 60000)
  assert.equal(otherLease.ok, true)
  otherLease.release()
})

test('group-wide RPM and per-user group RPM are independent; rejecting one dimension consumes none', (t) => {
  const { db, keys, a, b, key } = fixture(t)
  db.prepare('UPDATE custom_subscription_plans SET group_rpm_limit=2,user_rpm_limit=1 WHERE group_id=9').run()
  const one = key(),
    two = key(),
    other = key(b),
    separate = key(a, 10),
    now = 100000
  keys.acquire(one, now).release()
  assert.equal(keys.acquire(two, now).code, 'subscription_user_rpm_limit')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_request_rpm_events').get().n, 1)
  keys.acquire(other, now).release()
  assert.equal(keys.acquire(key(b), now).code, 'group_rpm_limit')
  keys.acquire(separate, now).release()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_request_rpm_events').get().n, 3)
  db.prepare('UPDATE custom_subscription_plans SET group_rpm_limit=0,user_rpm_limit=0 WHERE group_id=9').run()
  keys.acquire(two, now).release()
})

test('key-specific caps combine with user caps and transaction rollback leaves no shared RPM admission', (t) => {
  const { db, keys, key } = fixture(t)
  const capped = key(undefined, 9, { rpm: 1 })
  keys.acquire(capped, 100000).release()
  assert.equal(keys.acquire(capped, 100001).code, 'api_key_rate_limit')
  const next = key()
  let lease
  assert.throws(
    () =>
      withTransaction(db, () => {
        lease = keys.acquire(next, 100002)
        throw new Error('rollback')
      }),
    /rollback/,
  )
  lease.release()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM custom_request_rpm_events').get().n, 1)
  assert.equal(keys.userInflight.size, 0)
})

test('administrator managed keys honor explicit settings and invalid patches do not partially update the user', (t) => {
  const { users, keys, key } = fixture(t)
  const admin = users.create({ username: 'operator', password: 'test-password', role: 'admin' })
  assert.equal(admin.concurrency, 0)
  users.update(admin.id, { concurrency: 1, rpm_limit: 2 })
  const lease = keys.acquire(key(admin))
  assert.equal(lease.ok, true)
  assert.equal(keys.acquire(key(admin)).code, 'user_concurrency_limit')
  lease.release()
  for (const value of [-1, 1.5, null, '10', 1000001]) {
    assert.throws(() => users.update(admin.id, { rpm_limit: value, vm_create_quota: 12 }), /整数/)
    assert.equal(users.getById(admin.id).rpm_limit, 2)
    assert.equal(users.getById(admin.id).vm_create_quota, 0)
  }
})
