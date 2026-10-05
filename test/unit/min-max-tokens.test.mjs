import test from 'node:test'
import assert from 'node:assert/strict'
import { applyMinMaxTokens, normalizeMinMaxTokensConfig } from '../../src/lib/protocol/min-max-tokens.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'

test('raises small max_tokens to the default floor', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, undefined).max_tokens, 128)
  assert.equal(applyMinMaxTokens({ max_tokens: 16 }, { enabled: true, value: 128 }).max_tokens, 128)
})

test('cache replays retain their minimal output cap without mutating the cached prefix', () => {
  for (const max_tokens of [1, 16, 64]) {
    const body = {
      model: 'claude-haiku-4-5',
      max_tokens,
      system: [{ type: 'text', text: 'Pinned prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'Continue' }],
    }
    const before = structuredClone(body)
    assert.equal(applyMinMaxTokens(body, { value: 512 }), body)
    assert.deepEqual(body, before)
    assert.equal(prepareCliHopBody(body, { cacheTtl: '1h' }).max_tokens, max_tokens)
  }
})

test('cache replays keep enabled thinking and use budget plus one for an illegal output cap', () => {
  const body = {
    max_tokens: 1,
    thinking: { type: 'enabled', budget_tokens: 2048 },
    cache_control: { type: 'ephemeral' },
  }
  const out = applyMinMaxTokens(body, {})
  assert.equal(out.max_tokens, 2049)
  assert.deepEqual(out.thinking, body.thinking)
  assert.equal(body.max_tokens, 1)
  const legal = { ...body, max_tokens: 2049 }
  assert.equal(applyMinMaxTokens(legal, {}), legal)
})

test('unrelated or invalid cache fields do not disable the normal output floor', () => {
  for (const extra of [
    { metadata: { cache_control: { type: 'ephemeral' } } },
    { cache_control: { type: 'ephemeral', ttl: 'bogus' } },
    { messages: [{ role: 'assistant', content: [{ type: 'thinking', cache_control: { type: 'ephemeral' } }] }] },
  ])
    assert.equal(applyMinMaxTokens({ max_tokens: 1, ...extra }, {}).max_tokens, 128)
})

test('keeps values at or above the floor and leaves missing max_tokens alone', () => {
  const body = { max_tokens: 200 }
  assert.equal(applyMinMaxTokens(body, {}), body)
  const missing = { model: 'claude-haiku-4-5' }
  assert.equal(applyMinMaxTokens(missing, {}), missing)
})

test('disabled floor passes max_tokens through', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, { enabled: false, value: 128 }).max_tokens, 1)
})

test('disabling the floor preserves the caller budget through cli-hop preparation', () => {
  const body = applyMinMaxTokens(
    { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Print integers.' }] },
    { enabled: false },
  )
  assert.equal(prepareCliHopBody(body).max_tokens, 64)
})

test('custom floor value is honored and clamped', () => {
  assert.equal(applyMinMaxTokens({ max_tokens: 1 }, { value: 512 }).max_tokens, 512)
  assert.deepEqual(normalizeMinMaxTokensConfig({ value: 99999 }), { enabled: true, value: 4096 })
  assert.deepEqual(normalizeMinMaxTokensConfig({ value: 0 }), { enabled: true, value: 128 })
})

test('enabled thinking keeps max_tokens above budget_tokens', () => {
  const out = applyMinMaxTokens({ max_tokens: 1024, thinking: { type: 'enabled', budget_tokens: 2048 } }, {})
  assert.equal(out.max_tokens, 2048 + 128)
  const adaptive = applyMinMaxTokens({ max_tokens: 1024, thinking: { type: 'adaptive' } }, {})
  assert.equal(adaptive.max_tokens, 1024)
})

test('does not mutate the input body', () => {
  const body = { max_tokens: 1 }
  applyMinMaxTokens(body, {})
  assert.equal(body.max_tokens, 1)
})
