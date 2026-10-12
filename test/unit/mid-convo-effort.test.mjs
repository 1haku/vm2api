import test from 'node:test'
import assert from 'node:assert/strict'
import { officialMessagesBody } from '../../src/lib/protocol/anthropic-messages.mjs'
import { reasoningEffortOf } from '../../src/lib/protocol/log-fields.mjs'
import { isDbOpen } from '../../src/lib/db/database.mjs'
import { liftMidConversationSystemMessages, normalizeAnthropicMessages } from '../../src/lib/protocol/sanitize.mjs'
import {
  BETA_EFFORT,
  BETA_MID_CONVERSATION_OUTPUT_CONFIG,
  BETA_MID_CONVERSATION_SYSTEM,
  withRequestProtocolBetas,
} from '../../src/lib/protocol/claude-code-betas.mjs'
import {
  MID_CONVERSATION_SYSTEM_BETA,
  sanitizeAnthropicBodyForBetaTokens,
  stripInvalidThinkingBlocks,
} from '../../src/lib/protocol/anthropic-policy.mjs'
import { prepareCliHopBody } from '../../src/lib/protocol/outbound-attempt.mjs'
import { stripUnsupportedEffort } from '../../src/lib/protocol/thinking.mjs'
import { applyModelRequestRules } from '../../src/lib/protocol/model-policy.mjs'
import { applyMessageBreakpoints } from '../../src/lib/protocol/cache-ttl.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'
import { toClaudeMessages } from '../../src/lib/protocol/convert.mjs'

const ISSUE_INBOUND = {
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  stream: true,
  thinking: { type: 'adaptive', display: 'summarized' },
  output_config: { effort: 'high' },
  messages: [
    { role: 'user', content: 'Reply OK.' },
    { role: 'system', content: [], output_config: { effort: 'max' } },
  ],
}

test('issue 328: empty system control is dropped and current-turn effort=max is lifted', () => {
  const inbound = structuredClone(ISSUE_INBOUND)
  const outbound = officialMessagesBody(structuredClone(inbound))
  assert.equal(isDbOpen(), false)
  assert.equal(
    outbound.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(outbound.output_config.effort, 'max')
  assert.equal(outbound.messages[0].content[0].text, 'Reply OK.')
  assert.equal(reasoningEffortOf(inbound), 'max')
  const betas = withRequestProtocolBetas([], outbound)
  assert.equal(betas.includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG), false)
  assert.equal(betas.includes(BETA_MID_CONVERSATION_SYSTEM), false)
  assert.ok(betas.includes(BETA_EFFORT))
})

test('empty system control is dropped instead of merged into an adjacent system turn', () => {
  const body = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [{ type: 'text', text: 'reminder' }] },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user', 'system'],
  )
  assert.equal(body.messages[1].output_config, undefined)
  assert.equal(body.messages[1].content[0].text, 'reminder')
  assert.equal(body.output_config.effort, 'max')
})

test('historical empty system controls are dropped and only a trailing effort is lifted', () => {
  const historical = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'one' },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
    ],
  })
  assert.deepEqual(
    historical.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.equal(historical.output_config.effort, 'high')
  assert.equal(
    historical.messages.some((message) => message.output_config),
    false,
  )

  const current = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'one' },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'two' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.deepEqual(
    current.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
  assert.equal(current.output_config.effort, 'max')
  assert.equal(
    current.messages.some((message) => message.output_config),
    false,
  )
})

test('empty system with clear_at is dropped', () => {
  const body = officialMessagesBody({
    model: 'claude-opus-5-5',
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], clear_at: 0 },
    ],
  })
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user'],
  )
  assert.equal(
    body.messages.some((message) => message.clear_at != null),
    false,
  )
})

test('empty content without turn controls is still dropped', () => {
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [] },
      { role: 'assistant', content: '   ' },
    ],
  }
  normalizeAnthropicMessages(body)
  assert.deepEqual(
    body.messages.map((message) => message.role),
    ['user'],
  )
})

test('lift copies the last message-level effort onto top-level output_config', () => {
  const lifted = liftMidConversationSystemMessages({
    model: 'claude-sonnet-5',
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'low' } },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'again' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.equal(
    lifted.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(lifted.output_config.effort, 'max')
  assert.deepEqual(
    lifted.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  )
})

test('beta sanitize lifts controls on models that reject mid-conversation system', () => {
  const header = `oauth-2025-04-20,${MID_CONVERSATION_SYSTEM_BETA}`
  const sonnet5 = sanitizeAnthropicBodyForBetaTokens(
    {
      model: 'claude-sonnet-5',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ],
    },
    header,
  )
  assert.equal(
    sonnet5.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(sonnet5.output_config.effort, 'max')

  const opus = sanitizeAnthropicBodyForBetaTokens(
    {
      model: 'claude-opus-5-5',
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ],
    },
    header,
  )
  assert.equal(
    opus.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(opus.output_config.effort, 'max')
})

test('withRequestProtocolBetas derives mid-conversation-output-config from messages', () => {
  const derived = withRequestProtocolBetas(['caller-beta'], {
    model: 'claude-opus-5-5',
    output_config: { effort: 'high' },
    messages: [{ role: 'system', content: [], output_config: { effort: 'max' } }],
  })
  assert.ok(derived.includes('caller-beta'))
  assert.ok(derived.includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG))
  assert.ok(derived.includes(BETA_EFFORT))
  assert.ok(derived.includes(BETA_MID_CONVERSATION_SYSTEM))
  assert.deepEqual(withRequestProtocolBetas(['caller-beta'], { model: 'claude-sonnet-4-6' }), ['caller-beta'])
})

test('thinking strip drops empty system controls and lifts trailing effort', () => {
  const body = stripInvalidThinkingBlocks({
    model: 'claude-opus-5-5',
    thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: [{ type: 'text', text: 'reminder' }] },
      { role: 'system', content: [], output_config: { effort: 'max' } },
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'draft', signature: 'abc' }],
      },
    ],
  })
  assert.equal(
    body.messages.some((message) => message.role === 'assistant'),
    false,
  )
  assert.equal(
    body.messages.some((message) => message.content?.[0]?.text === 'reminder'),
    true,
  )
  assert.equal(body.output_config.effort, 'max')
  assert.equal(
    body.messages.some((message) => message.role === 'system' && message.output_config),
    false,
  )
})

test('stripUnsupportedEffort drops message-level effort on Haiku', () => {
  const stripped = stripUnsupportedEffort({
    model: 'claude-haiku-4-5',
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.equal(stripped.output_config, undefined)
  assert.equal(
    stripped.messages.some((message) => message.output_config),
    false,
  )
  assert.deepEqual(
    stripped.messages.map((message) => message.role),
    ['user'],
  )
})

test('prepareCliHopBody lifts trailing message-level max on Opus 5.5', () => {
  const body = prepareCliHopBody(structuredClone(ISSUE_INBOUND))
  assert.equal(
    body.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(body.output_config.effort, 'max')
  assert.equal(body.messages[0].content[0].text, 'Reply OK.')
  assert.ok(body.messages[0].content[0].cache_control)
})

test('prepareCliHopBody lifts last effort on Sonnet 5 and strips it on Haiku', () => {
  const sonnet = prepareCliHopBody({
    model: 'claude-sonnet-5',
    max_tokens: 256,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.equal(
    sonnet.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(sonnet.output_config.effort, 'max')

  const haiku = prepareCliHopBody({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: [], output_config: { effort: 'max' } },
    ],
  })
  assert.equal(haiku.output_config, undefined)
  assert.equal(
    haiku.messages.some((message) => message.role === 'system' || message.output_config),
    false,
  )
})

test('toClaudeMessages passthrough and rewrite both drop the empty control', () => {
  const passthrough = toClaudeMessages('anthropic.messages', structuredClone(ISSUE_INBOUND)).claude
  assert.equal(
    passthrough.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(passthrough.output_config.effort, 'max')
  const rewritten = toClaudeMessages('anthropic.messages', structuredClone(ISSUE_INBOUND), {
    rewrite: true,
    model_map: false,
  }).claude
  const hop = officialMessagesBody(rewritten)
  assert.equal(
    hop.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(hop.output_config.effort, 'max')
})

test('cache rewrite stamps the last content-bearing turn, not an empty control', () => {
  const out = applyMessageBreakpoints(
    {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: [], output_config: { effort: 'max' } },
      ],
    },
    '1h',
    'rewrite',
  )
  assert.deepEqual(out.messages[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal(out.messages[1].content.length, 0)
})

test('cli-hop worker envelope drops the empty effort control and keeps its effort', () => {
  const body = prepareCliHopBody(structuredClone(ISSUE_INBOUND))
  const out = finalizeWorkerPayload({
    body,
    reqHeaders: {},
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
    cliHop: true,
  })
  assert.equal(
    out.body.messages.some((message) => message.role === 'system'),
    false,
  )
  assert.equal(out.body.output_config.effort, 'max')
  assert.equal(out.body.betas.includes(BETA_MID_CONVERSATION_OUTPUT_CONFIG), false)
  assert.ok(out.body.betas.includes(BETA_EFFORT))
})

test('Haiku 5.5 disabled+max at message-level still becomes adaptive', () => {
  const blocked = applyModelRequestRules({
    model: 'claude-haiku-5-5',
    thinking: { type: 'disabled' },
    output_config: { effort: 'high' },
    messages: [{ role: 'system', content: [], output_config: { effort: 'max' } }],
  })
  assert.deepEqual(blocked.thinking, { type: 'adaptive' })
})
