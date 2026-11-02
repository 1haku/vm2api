import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createWeeklyQuotaNotify,
  weeklyNotifyStore,
  weeklyThreshold,
  weeklyMessage,
} from '../../src/lib/admin/weekly-quota-notify.mjs'
import { weeklyCreditView, createWeeklyQuotaSource } from '../../src/lib/admin/weekly-quota-source.mjs'
import {
  normalizeNotifyConfig,
  mergeNotifyConfig,
  publicNotifyConfig,
  telegramRequest,
} from '../../src/lib/admin/notify.mjs'

function fixture(t) {
  const db = new DatabaseSync(':memory:')
  db.exec(
    fs.readFileSync(new URL('../../src/lib/db/custom-migrations/008_weekly_quota_notify.sql', import.meta.url), 'utf8'),
  )
  const store = weeklyNotifyStore(() => db),
    calls = []
  let clock = Date.parse('2026-11-03T00:00:00Z'),
    used = 90,
    account = 'account-1',
    end = clock + 6 * 86400000,
    redeemCount = 0
  let cfg = normalizeNotifyConfig({
    enabled: true,
    weekly_quota_enabled: true,
    telegram: { enabled: true, bot_token: 'secret', chat_id: '42' },
  })
  let sampleOverride = null,
    failSend = false,
    webhook = false,
    failRedeem = false
  const source = {
    list: () => ['slot-1'],
    identity: () => account,
    sample: async () =>
      sampleOverride
        ? sampleOverride()
        : {
            id: 'slot-1',
            name: '测试账号',
            account,
            provider: 'Claude',
            used,
            at: clock,
            end,
            credits: { known: true, held: 1, available: 1 },
          },
    redeem: async () => {
      redeemCount++
      if (failRedeem) throw new Error('timeout')
      used = 0
      return { confirmed: true }
    },
  }
  const request = async (_c, method, body) => {
    calls.push({ method, body })
    if (method === 'getMe') return { id: 99, is_bot: true }
    if (method === 'getWebhookInfo') return { url: webhook ? 'https://example.test/hook' : '' }
    if (method === 'sendMessage') {
      if (failSend) throw new Error('send_failed')
      return { message_id: calls.filter((c) => c.method === method).length }
    }
    return true
  }
  const make = () => createWeeklyQuotaNotify({ getConfig: () => cfg, store, source, request, now: () => clock })
  const m = make()
  t.after(async () => {
    await m.stop()
    db.close()
  })
  const messages = () => calls.filter((c) => c.method === 'sendMessage')
  const query = (index = messages().length - 1) => ({
    id: 'query-id',
    from: { id: 42 },
    data: messages()[index].body.reply_markup.inline_keyboard[0][0].callback_data,
    message: { message_id: index + 1, from: { id: 99 }, chat: { id: 42, type: 'private' } },
  })
  return {
    m,
    make,
    store,
    calls,
    messages,
    query,
    source,
    get redeemCount() {
      return redeemCount
    },
    advance(n = 300000) {
      clock += n
    },
    setUsed(n) {
      used = n
    },
    setAccount(n) {
      account = n
    },
    setEnd(n) {
      end += n
    },
    setConfig(patch) {
      cfg = mergeNotifyConfig(cfg, patch)
    },
    setWebhook() {
      webhook = true
    },
    failSend(v) {
      failSend = v
    },
    failRedeem() {
      failRedeem = true
    },
    setSample(fn) {
      sampleOverride = fn
    },
    now: () => clock,
  }
}

test('remaining thresholds use official percentages, including exact boundaries and zero', () => {
  assert.deepEqual([89, 90, 94, 95, 97, 99, 100, null, NaN, 101].map(weeklyThreshold), [
    null,
    10,
    10,
    5,
    3,
    1,
    0,
    null,
    null,
    null,
  ])
})

test('Claude imports without metadata use official identity; refresh keeps identity and account replacement invalidates cache', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-identity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'vms', 'Claude', 'cli-home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'Claude.json'),
    JSON.stringify({ id: 'Claude', platform: 'anthropic', claude: { mode: 'oauth', has_access: true } }),
  )
  const file = path.join(home, 'credentials.json')
  fs.writeFileSync(file, 'first-credential')
  let account = 'official-account-1',
    calls = 0
  const source = createWeeklyQuotaSource({
    projectRoot: root,
    identityTransport: async () => {
      calls++
      return { ok: true, status: 200, body: { account: { uuid: account }, organization: { uuid: 'org-1' } } }
    },
  })
  const first = await source.identity('Claude')
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(await source.identity('Claude'), first)
  assert.equal(calls, 1)
  fs.writeFileSync(file, 'refreshed-credential')
  assert.equal(await source.identity('Claude'), first)
  assert.equal(calls, 2)
  fs.writeFileSync(file, 'replacement-credential')
  account = 'official-account-2'
  assert.notEqual(await source.identity('Claude'), first)
  assert.equal(calls, 3)
  assert.equal(await source.identity('deleted-slot'), null)
})

test('an incomplete profile or credentials replaced during identity lookup fail closed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-profile-race-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const home = path.join(root, 'vms', 'Claude', 'cli-home', '.claude')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', 'Claude.json'),
    JSON.stringify({ id: 'Claude', platform: 'anthropic', claude: { mode: 'oauth' } }),
  )
  const file = path.join(home, 'credentials.json')
  fs.writeFileSync(file, 'first')
  const incomplete = createWeeklyQuotaSource({
    projectRoot: root,
    identityTransport: async () => ({ ok: true, status: 200, body: { account: { uuid: 'a' } } }),
  })
  assert.equal(await incomplete.identity('Claude'), null)
  const raced = createWeeklyQuotaSource({
    projectRoot: root,
    identityTransport: async () => {
      fs.writeFileSync(file, 'replacement')
      return { ok: true, status: 200, body: { account: { uuid: 'a' }, organization: { uuid: 'org' } } }
    },
  })
  assert.equal(await raced.identity('Claude'), null)
})
test('all five thresholds notify once; retries, restarts and jitter do not replay prior alerts', async (t) => {
  const f = fixture(t)
  for (const used of [90, 90, 95, 94, 97, 99, 100, 99]) {
    f.setUsed(used)
    f.advance()
    await f.m.runOnce()
  }
  assert.equal(f.messages().length, 5)
  const resumed = f.make()
  await resumed.runOnce()
  await resumed.stop()
  assert.equal(f.messages().length, 5)
  assert.match(f.messages()[0].body.text, /下次周期更新.*UTC\+09:00/)
  assert.ok(Buffer.byteLength(f.query().data) <= 64)
})
test('a jump to exhausted sends one useful alert, a new official window re-arms', async (t) => {
  const f = fixture(t)
  f.setUsed(100)
  await f.m.runOnce()
  assert.equal(f.messages().length, 1)
  f.advance(7 * 86400000)
  f.setEnd(7 * 86400000)
  f.setUsed(95)
  await f.m.runOnce()
  assert.equal(f.messages().length, 2)
})
test('two separately timed official zero samples re-arm early resets; a single zero cannot', async (t) => {
  const f = fixture(t)
  await f.m.runOnce()
  f.advance()
  f.setUsed(0)
  await f.m.runOnce()
  f.advance()
  f.setUsed(90)
  await f.m.runOnce()
  assert.equal(f.messages().length, 1)
  f.advance()
  f.setUsed(0)
  await f.m.runOnce()
  f.advance()
  await f.m.runOnce()
  f.advance()
  f.setUsed(90)
  await f.m.runOnce()
  assert.equal(f.messages().length, 2)
})
test('different slots of the same account share deduplication', async (t) => {
  const f = fixture(t)
  f.source.list = () => ['slot-1', 'slot-2']
  await f.m.runOnce()
  assert.equal(f.messages().length, 1)
})

test('repeated cached zero samples preserve but cannot confirm early reset evidence', async (t) => {
  const f = fixture(t)
  await f.m.runOnce()
  f.setUsed(0)
  f.advance(10000)
  const zeroAt = f.now()
  const zero = await f.source.sample()
  f.setSample(() => zero)
  await f.m.runOnce()
  const cycle = f.store.get('account:account-1').cycle
  f.advance(30000)
  await f.m.runOnce()
  assert.equal(f.store.get('account:account-1').cycle, cycle)
  assert.equal(f.store.get('account:account-1').zeroAt, zeroAt)
  f.setSample(() => ({ ...zero, at: f.now() }))
  await f.m.runOnce()
  assert.notEqual(f.store.get('account:account-1').cycle, cycle)
})

test('only a newly crossed threshold prepares cards; callback requests forced fresh validation', async (t) => {
  const f = fixture(t)
  let prepared = 0
  f.source.prepareNotification = async (s) => {
    prepared++
    return s
  }
  await f.m.runOnce()
  for (let i = 0; i < 5; i++) {
    f.advance(15000)
    await f.m.runOnce()
  }
  assert.equal(prepared, 1)
  const original = f.source.sample,
    options = []
  f.source.sample = (id, opts) => {
    options.push(opts)
    return original(id, opts)
  }
  await f.m.handleCallback(f.query())
  assert.deepEqual(options[0], { force: true, credits: true })
  assert.deepEqual(options[1], { force: true })
})
test('failed sends can retry; unknown or stale snapshots never become zero/exhausted alerts', async (t) => {
  const f = fixture(t)
  f.failSend(true)
  await f.m.runOnce()
  assert.ok(f.m.getStatus().last_error)
  f.failSend(false)
  await f.m.runOnce()
  assert.equal(f.messages().length, 2)
  f.setSample(() => null)
  f.advance()
  await f.m.runOnce()
  assert.equal(f.messages().length, 2)
  f.setSample(() => ({ id: 'slot-1', account: 'account-1', used: 100, at: f.now() - 600000, end: f.now() + 86400000 }))
  await f.m.runOnce()
  assert.equal(f.messages().length, 2)
})
test('private authorized click redeems once, updates message and removes button', async (t) => {
  const f = fixture(t)
  await f.m.runOnce()
  const q = f.query()
  await Promise.all([f.m.handleCallback(q), f.m.handleCallback(q)])
  assert.equal(f.redeemCount, 1)
  const edited = f.calls.find((c) => c.method === 'editMessageText')
  assert.match(edited.body.text, /重置成功/)
  assert.deepEqual(edited.body.reply_markup.inline_keyboard, [])
  f.advance()
  f.setUsed(90)
  await f.m.runOnce()
  assert.equal(f.messages().length, 2)
})
for (const field of ['user', 'chat', 'bot', 'message', 'token', 'account', 'cycle', 'config', 'expired']) {
  test(`callback rejects changed/forged ${field} without spending a card`, async (t) => {
    const f = fixture(t)
    await f.m.runOnce()
    const q = f.query()
    if (field === 'user') q.from.id = 43
    if (field === 'chat') q.message.chat.id = 43
    if (field === 'bot') q.message.from.id = 43
    if (field === 'message') q.message.message_id = 99
    if (field === 'token') q.data = 'wq:' + 'X'.repeat(24)
    if (field === 'account') f.setAccount('replacement')
    if (field === 'cycle') f.setEnd(86400000)
    if (field === 'config') f.setConfig({ telegram: { chat_id: '43' } })
    if (field === 'expired') f.advance(7 * 86400000)
    await f.m.handleCallback(q)
    assert.equal(f.redeemCount, 0)
  })
}
test('ambiguous redemption is fenced across messages and monitor restart', async (t) => {
  const f = fixture(t)
  await f.m.runOnce()
  const first = f.query()
  f.setUsed(95)
  f.advance()
  await f.m.runOnce()
  const second = f.query()
  f.failRedeem()
  await f.m.handleCallback(first)
  const resumed = f.make()
  await resumed.runOnce()
  await resumed.handleCallback(second)
  await resumed.stop()
  assert.equal(f.redeemCount, 1)
  assert.match(f.calls.find((c) => c.method === 'editMessageText').body.text, /阻止重复兑换/)
})
test('webhook is preserved and group recipients receive no spending buttons', async (t) => {
  const f = fixture(t)
  f.setWebhook()
  await f.m.runOnce()
  assert.equal(f.messages()[0].body.reply_markup, undefined)
  assert.match(f.m.getStatus().callback_error, /webhook/)
  assert.ok(!f.calls.some((c) => c.method === 'deleteWebhook'))
  f.setConfig({ telegram: { chat_id: '-100123' } })
  f.setUsed(95)
  await f.m.runOnce()
  assert.equal(f.messages()[1].body.reply_markup, undefined)
})
test('disabled feature never queries official endpoints or Telegram', async (t) => {
  const f = fixture(t)
  f.setConfig({ weekly_quota_enabled: false })
  await f.m.runOnce()
  assert.equal(f.calls.length, 0)
})
test('credit projection excludes short-window-only, expired and stale cards', () => {
  const now = Date.now(),
    fetched_at = new Date(now).toISOString()
  assert.deepEqual(
    weeklyCreditView(
      'Claude',
      {
        fetched_at,
        credits: [
          { clears: ['five_hour'], resets_left: 2, redeemable: true },
          { clears: ['seven_day'], resets_left: 1, redeemable: false },
        ],
      },
      now,
    ),
    { known: true, held: 1, available: 0 },
  )
  assert.equal(
    weeklyCreditView(
      'Codex',
      { fetched_at, available_count: 1, credits: [{ expires_at: new Date(now - 1).toISOString() }] },
      now,
    ).available,
    0,
  )
  assert.equal(weeklyCreditView('Codex', { fetched_at }, now + 300000).known, false)
})
test('Telegram transport preserves timeout/redaction and passes callback payloads', async () => {
  const cfg = normalizeNotifyConfig({ telegram: { bot_token: 'SECRET', chat_id: '42' } })
  const calls = []
  const result = await telegramRequest(
    cfg,
    'answerCallbackQuery',
    { callback_query_id: 'test' },
    {
      fetch: async (url, options) => {
        calls.push({ url, options })
        return { ok: true, text: async () => JSON.stringify({ ok: true, result: true }) }
      },
    },
  )
  assert.equal(result, true)
  assert.deepEqual(JSON.parse(calls[0].options.body), { callback_query_id: 'test' })
  await assert.rejects(
    telegramRequest(
      cfg,
      'getMe',
      {},
      {
        fetch: async () => {
          throw new Error('SECRET broken')
        },
      },
    ),
    (e) => !e.message.includes('SECRET'),
  )
  assert.equal(publicNotifyConfig(cfg).telegram.bot_token, '')
})
