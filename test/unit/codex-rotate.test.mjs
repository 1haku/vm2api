import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyCodexRotate,
  collectTurnState,
  createTurnStateStore,
  extractTurnStateValue,
  injectTurnState,
  lengthAllowed,
  normalizeCodexRotate,
  observeHopTurnState,
  putTurnState,
  scheduleCodexRotateCollect,
} from '../../src/lib/protocol/codex-rotate.mjs'
import { normalizeCodexRouting } from '../../src/lib/protocol/codex-route.mjs'

test('normalizeCodexRotate defaults off', () => {
  const cfg = normalizeCodexRotate()
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.inject_state, true)
  assert.deepEqual(cfg.state_lengths, [292, 332])
})

test('normalizeCodexRouting keeps plugin.rotate', () => {
  const routing = normalizeCodexRouting({
    plugin: { rotate: { enabled: true, state_ttl_seconds: 120 } },
  })
  assert.equal(routing.plugin.rotate.enabled, true)
  assert.equal(routing.plugin.rotate.state_ttl_seconds, 120)
  assert.equal(normalizeCodexRouting().plugin.rotate.enabled, false)
})

test('injectTurnState writes body and client_metadata', () => {
  const token = 'x'.repeat(292)
  const next = injectTurnState({ model: 'gpt-6-astra' }, token)
  assert.equal(next.turn_state, token)
  assert.equal(next.client_metadata['x-codex-turn-state'], token)
  assert.equal(next.model, 'gpt-6-astra')
})

test('applyCodexRotate injects only when enabled and length is 292/332', () => {
  const store = createTurnStateStore()
  const token = 't'.repeat(292)
  putTurnState({ vmId: 'vm-1', account: 'acc', model: 'gpt-6-astra', value: token, store })
  const off = applyCodexRotate({
    body: { model: 'gpt-6-astra' },
    routing: { plugin: { rotate: { enabled: false } } },
    account: 'acc',
    model: 'gpt-6-astra',
    vmId: 'vm-1',
    store,
  })
  assert.equal(off.injected, false)
  assert.equal(off.body.turn_state, undefined)
  assert.equal(off.needCollect, false)

  const on = applyCodexRotate({
    body: { model: 'gpt-6-astra' },
    routing: { plugin: { rotate: { enabled: true } } },
    account: 'acc',
    model: 'gpt-6-astra',
    vmId: 'vm-1',
    store,
  })
  assert.equal(on.injected, true)
  assert.equal(on.body.turn_state, token)

  const wrongVm = applyCodexRotate({
    body: { model: 'gpt-6-astra' },
    routing: { plugin: { rotate: { enabled: true } } },
    account: 'acc',
    model: 'gpt-6-astra',
    vmId: 'vm-other',
    store,
  })
  assert.equal(wrongVm.injected, false)
  assert.equal(wrongVm.needCollect, true)
})

test('wrong-length values are not stored or injected', () => {
  const store = createTurnStateStore()
  assert.equal(
    observeHopTurnState({
      headers: { 'x-codex-turn-state': 'short' },
      account: 'acc',
      model: 'gpt-6-astra',
      vmId: 'vm-1',
      store,
    }),
    null,
  )
  assert.equal(lengthAllowed(291, [292, 332]), false)
  assert.equal(lengthAllowed(332, [292, 332]), true)
})

test('TTL expiry drops cached turn-state', () => {
  const store = createTurnStateStore()
  const t0 = 1_000_000
  putTurnState({
    vmId: 'vm-1',
    account: 'acc',
    model: 'gpt-5.5',
    value: 'a'.repeat(332),
    now: t0,
    store,
  })
  const live = applyCodexRotate({
    body: { model: 'gpt-5.5' },
    routing: { plugin: { rotate: { enabled: true, state_ttl_seconds: 60 } } },
    account: 'acc',
    model: 'gpt-5.5',
    vmId: 'vm-1',
    now: t0 + 30_000,
    store,
  })
  assert.equal(live.injected, true)
  const expired = applyCodexRotate({
    body: { model: 'gpt-5.5' },
    routing: { plugin: { rotate: { enabled: true, state_ttl_seconds: 60 } } },
    account: 'acc',
    model: 'gpt-5.5',
    vmId: 'vm-1',
    now: t0 + 61_000,
    store,
  })
  assert.equal(expired.injected, false)
})

test('extractTurnStateValue reads header maps and getters', () => {
  assert.equal(extractTurnStateValue({ 'x-codex-turn-state': 'abc' }), 'abc')
  assert.equal(
    extractTurnStateValue({
      get(name) {
        return name.toLowerCase() === 'x-codex-turn-state' ? 'from-get' : ''
      },
    }),
    'from-get',
  )
})

test('collectTurnState stores a 292 header and ignores other lengths', async () => {
  const store = createTurnStateStore()
  const ok = await collectTurnState({
    accessToken: 'tok',
    account: 'acc',
    model: 'gpt-6-astra',
    vmId: 'vm-1',
    store,
    fetchImpl: async () => ({
      status: 200,
      headers: { 'x-codex-turn-state': 'c'.repeat(292) },
      text: async () => '',
    }),
  })
  assert.equal(ok.collected, true)
  const skip = await collectTurnState({
    accessToken: 'tok',
    account: 'acc',
    model: 'gpt-6-astra',
    vmId: 'vm-1',
    store,
    fetchImpl: async () => ({
      status: 200,
      headers: { 'x-codex-turn-state': 'nope' },
      text: async () => '',
    }),
  })
  assert.equal(skip.collected, false)
})

test('scheduleCodexRotateCollect is off when plugin disabled and debounces', async () => {
  const store = createTurnStateStore()
  let n = 0
  const collectImpl = async () => {
    n += 1
    return { ok: true, collected: false }
  }
  const off = scheduleCodexRotateCollect({
    cfg: { enabled: false, auto_collect: true, probe_model: 'gpt-6-astra' },
    vmId: 'vm-schedule',
    account: 'acc-schedule',
    model: 'gpt-6-astra',
    collectImpl,
    store,
  })
  assert.equal(off.scheduled, false)
  assert.equal(n, 0)
  const first = scheduleCodexRotateCollect({
    cfg: { enabled: true, auto_collect: true, probe_model: 'gpt-6-astra', state_ttl_seconds: 3600 },
    vmId: 'vm-schedule',
    account: 'acc-schedule',
    model: 'gpt-6-astra',
    collectImpl,
    now: 1000,
    store,
  })
  assert.equal(first.scheduled, true)
  await first.work
  const again = scheduleCodexRotateCollect({
    cfg: { enabled: true, auto_collect: true, probe_model: 'gpt-6-astra', state_ttl_seconds: 3600 },
    vmId: 'vm-schedule',
    account: 'acc-schedule',
    model: 'gpt-6-astra',
    collectImpl,
    now: 2000,
    store,
  })
  assert.equal(again.scheduled, false)
  assert.equal(again.reason, 'debounced')
  assert.equal(n, 1)
})
