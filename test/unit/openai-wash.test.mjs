import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WASHED_OPENAI_PATH,
  WASHED_OPENAI_PROTOCOL,
  applyOpenaiWashLog,
  publicWashedResponsesBody,
  summarizeWashedResponses,
} from '../../src/lib/protocol/openai-wash.mjs'

test('applyOpenaiWashLog overwrites inbound chat path/protocol', () => {
  const logBag = { protocol: 'openai.chat', path: '/v1/chat/completions' }
  applyOpenaiWashLog(logBag, {
    inboundPath: '/v1/chat/completions',
    inboundProtocol: 'openai.chat',
    converted: true,
    outboundBody: {
      model: 'gpt-5.6-sol',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true,
      turn_state: 'secret',
      client_metadata: { 'x-codex-turn-state': 'secret' },
    },
  })
  assert.equal(logBag.protocol, WASHED_OPENAI_PROTOCOL)
  assert.equal(logBag.path, WASHED_OPENAI_PATH)
  assert.equal(logBag.hop_meta.inbound_path, '/v1/chat/completions')
  assert.equal(logBag.hop_meta.inbound_protocol, 'openai.chat')
  assert.equal(logBag.hop_meta.washed_path, '/v1/responses')
  assert.equal(logBag.outbound_body.turn_state, undefined)
  assert.equal(logBag.outbound_body.client_metadata['x-codex-turn-state'], undefined)
  assert.equal(logBag.outbound_summary.input_count, 1)
  assert.ok(!logBag.outbound_summary.top_level_keys.includes('turn_state'))
})

test('public wash body drops rotate secrets', () => {
  const out = publicWashedResponsesBody({
    model: 'gpt-5.6-sol',
    input: [],
    turn_state: 'secret',
    client_metadata: { session_id: 'keep', 'x-codex-turn-state': 'secret' },
  })
  assert.equal(out.turn_state, undefined)
  assert.equal(out.client_metadata.session_id, 'keep')
  assert.equal(out.client_metadata['x-codex-turn-state'], undefined)
})

test('summarize washed responses counts input items', () => {
  const sum = summarizeWashedResponses({
    model: 'gpt-5.6-sol',
    input: [{ type: 'message', role: 'user', content: [] }],
    tools: [{ type: 'function', name: 'x' }],
  })
  assert.equal(sum.input_count, 1)
  assert.equal(sum.tools_count, 1)
})
