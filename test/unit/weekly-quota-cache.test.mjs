import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWeeklyQuotaSource } from '../../src/lib/admin/weekly-quota-source.mjs'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { codexWeeklyAccountKey } from '../../src/lib/protocol/codex-weekly-reset.mjs'

async function fixture(t, codex = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-cache-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const id = codex ? 'GPT' : 'Claude',
    file = path.join(root, 'vms', `${id}.json`)
  const home = path.join(root, 'vms', id, 'cli-home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  const credential = path.join(home, 'credentials.json')
  fs.writeFileSync(credential, 'first-credential')
  let clock = Date.now(),
    used = 96,
    owner = 'account-1',
    refreshes = 0,
    cards = 0,
    profiles = 0
  let vm = codex
    ? { id, platform: 'openai', codex: { chatgpt_account_id: 'account-1', email: 'a@example.test' } }
    : { id, platform: 'anthropic', claude: { mode: 'oauth', has_access: true } }
  atomicWriteJson(file, vm)
  let acc = {},
    mode = 'ok'
  const state = new Map(),
    store = { get: (k) => state.get(k), set: (k, v) => state.set(k, v) }
  function publish(at = clock, end = clock + 6 * 86400000) {
    if (codex) {
      vm.codex.subscription_weekly = { account: codexWeeklyAccountKey(vm), at, end, used }
      atomicWriteJson(file, vm)
    } else {
      acc = {
        last_probe: { at: new Date(at).toISOString() },
        unified: {
          official: {
            '7d': { utilization: used / 100, reset: new Date(end).toISOString() },
            updated_at: new Date(at).toISOString(),
          },
          headers: { '7d': { utilization: 1, reset: new Date(end).toISOString() } },
        },
      }
    }
  }
  const options = {
    projectRoot: root,
    store,
    now: () => clock,
    accountQuota: { repo: { get: () => acc } },
    identityTransport: async () => {
      profiles++
      return { ok: true, status: 200, body: { account: { uuid: owner }, organization: { uuid: 'org' } } }
    },
    refreshQuota: async () => {
      refreshes++
      await Promise.resolve()
      if (mode === 'throw') throw new Error('offline')
      if (mode === 'unchanged') return { ok: false }
      clock++
      publish()
    },
    queryCredits: async () => {
      cards++
      return { ok: true, claude_reset_credits: { fetched_at: new Date(clock).toISOString(), credits: [] } }
    },
  }
  const make = () => createWeeklyQuotaSource(options),
    source = make()
  await source.identity(id)
  publish()
  return {
    source,
    make,
    id,
    options,
    publish,
    advance(ms) {
      clock += ms
    },
    setUsed(n) {
      used = n
    },
    fail(value) {
      mode = value
    },
    switchAccount() {
      owner = 'account-2'
      fs.writeFileSync(credential, 'replacement-credential')
    },
    mutate(fn) {
      fn(acc, vm)
      atomicWriteJson(file, vm)
    },
    get now() {
      return clock
    },
    get counts() {
      return { refreshes, cards, profiles }
    },
  }
}

for (const codex of [false, true]) {
  test(`${codex ? 'Codex' : 'Claude'} reuses live official samples and never fabricates timestamps`, async (t) => {
    const f = await fixture(t, codex),
      first = await f.source.sample(f.id)
    assert.equal(first.used, 96)
    for (let i = 0; i < 10; i++) {
      f.advance(15000)
      assert.equal((await f.source.sample(f.id)).at, first.at)
    }
    assert.equal(f.counts.refreshes, 0)
    assert.equal(f.counts.cards, 0)
    assert.equal(f.counts.profiles, codex ? 0 : 1)
    // A new sample from traffic / another probe is picked up without another GET.
    f.setUsed(99)
    f.publish()
    assert.equal((await f.source.sample(f.id)).used, 99)
    assert.equal(f.counts.refreshes, 0)
  })
  test(`${codex ? 'Codex' : 'Claude'} stale fallback is single-flight and failed refreshes back off`, async (t) => {
    const f = await fixture(t, codex)
    f.advance(301000)
    const results = await Promise.all([f.source.sample(f.id), f.source.sample(f.id)])
    assert.ok(results.every((s) => s?.used === 96))
    assert.equal(f.counts.refreshes, 1)
    f.advance(301000)
    f.fail('throw')
    await assert.rejects(f.source.sample(f.id), /offline/)
    f.advance(15000)
    assert.equal(await f.source.sample(f.id), null)
    assert.equal(f.counts.refreshes, 2)
    f.advance(60000)
    f.fail('ok')
    assert.ok(await f.source.sample(f.id))
    assert.equal(f.counts.refreshes, 3)
  })
}

test('persisted identity survives restart; a different account cannot reuse the old quota row', async (t) => {
  const f = await fixture(t)
  f.advance(15000)
  assert.ok(await f.make().sample(f.id))
  assert.equal(f.counts.profiles, 1)
  const first = await f.source.sample(f.id)
  f.switchAccount()
  f.fail('unchanged')
  assert.equal(await f.source.sample(f.id), null)
  f.advance(60000)
  f.fail('ok')
  assert.notEqual((await f.source.sample(f.id)).account, first.account)
})

test('official rate-limit backoff and reset boundary override normal freshness', async (t) => {
  const f = await fixture(t)
  f.advance(301000)
  f.mutate((acc) => {
    acc.unified.usage_rate_limited_until = new Date(f.now + 600000).toISOString()
  })
  assert.equal(await f.source.sample(f.id), null)
  assert.equal(f.counts.refreshes, 0)
  f.advance(601000)
  assert.ok(await f.source.sample(f.id))
  f.publish(f.now, f.now + 1000)
  f.advance(2000)
  assert.ok(await f.source.sample(f.id))
  assert.equal(f.counts.refreshes, 2)
})

test('Extra headers do not replace official totals or date old cached official samples', async (t) => {
  const f = await fixture(t)
  const first = await f.source.sample(f.id)
  f.advance(15000)
  f.mutate((acc) => {
    acc.unified.official.updated_at = new Date(f.now).toISOString()
  })
  assert.equal((await f.source.sample(f.id)).at, first.at)
  f.mutate((acc) => {
    delete acc.unified.official
    acc.unified.source = 'headers'
  })
  f.fail('unchanged')
  assert.equal(await f.source.sample(f.id), null)
})

test('notification preparation alone queries Claude cards; forced validation cannot reuse a failed refresh', async (t) => {
  const f = await fixture(t)
  const cached = await f.source.sample(f.id)
  assert.equal(f.counts.cards, 0)
  assert.equal((await f.source.prepareNotification(cached)).credits.known, true)
  assert.equal(f.counts.cards, 1)
  assert.equal(f.counts.refreshes, 0)
  f.advance(1000)
  const fresh = await f.source.sample(f.id, { force: true, credits: true })
  assert.ok(fresh.at > cached.at)
  assert.equal(f.counts.refreshes, 1)
  f.fail('unchanged')
  f.advance(1000)
  assert.equal(await f.source.sample(f.id, { force: true, credits: true }), null)
})

test('Codex snapshots belonging to an old account are ignored', async (t) => {
  const f = await fixture(t, true)
  f.mutate((_acc, vm) => {
    vm.codex.subscription_weekly.account = 'other-account'
  })
  f.fail('unchanged')
  assert.equal(await f.source.sample(f.id), null)
})
