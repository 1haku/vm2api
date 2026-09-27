import test from 'node:test'
import assert from 'node:assert/strict'
import { detectWarmupIntercept, formatWarmupSse, warmupMockMessage } from '../../src/lib/protocol/warmup-intercept.mjs'
import { normalizeHealthProbeConfig } from '../../src/lib/admin/health-probe.mjs'

const user = (content) => ({ role: 'user', content })

test('detects haiku max_tokens=1 ping', () => {
  assert.equal(
    detectWarmupIntercept({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [user('quota')] }),
    'haiku_ping',
  )
  assert.equal(detectWarmupIntercept({ model: 'claude-sonnet-5', max_tokens: 1, messages: [user('quota')] }), null)
  assert.equal(detectWarmupIntercept({ model: 'claude-haiku-4-5', max_tokens: 2, messages: [user('quota')] }), null)
})

test('detects suggestion mode on a bare side call', () => {
  const body = {
    model: 'claude-opus-5-5',
    messages: [user([{ type: 'text', text: '[SUGGESTION MODE: next]' }])],
  }
  assert.equal(detectWarmupIntercept(body), 'suggestion')
})

test('a long conversation that quotes the prompts is never intercepted', () => {
  const title = 'Please write a 5-10 word title for the following conversation: x'
  const history = [
    user(title),
    { role: 'assistant', content: 'Warmup' },
    user([{ type: 'text', text: 'Warmup' }]),
    { role: 'assistant', content: 'ok' },
    user('[SUGGESTION MODE: next]'),
  ]
  assert.equal(detectWarmupIntercept({ model: 'claude-opus-5-5', messages: history }), null)
  assert.equal(
    detectWarmupIntercept({ model: 'claude-opus-5-5', messages: [user(title)], tools: [{ name: 'Bash' }] }),
    null,
  )
  assert.equal(
    detectWarmupIntercept({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      messages: [user('a'), { role: 'assistant', content: 'b' }, user('c')],
    }),
    null,
  )
})

test('detects warmup and title generation', () => {
  assert.equal(detectWarmupIntercept({ messages: [user([{ type: 'text', text: 'Warmup' }])] }), 'warmup')
  assert.equal(
    detectWarmupIntercept({
      messages: [user('Please write a 5-10 word title for the following conversation: abc')],
    }),
    'warmup',
  )
  assert.equal(
    detectWarmupIntercept({
      system: [
        {
          type: 'text',
          text: 'Analyze if this message indicates a new conversation topic. If it does, extract a 2-3 word title',
        },
      ],
      messages: [user('fix the bug')],
    }),
    'warmup',
  )
})

test('ordinary conversations are not intercepted', () => {
  assert.equal(
    detectWarmupIntercept({ model: 'claude-haiku-4-5', max_tokens: 1024, messages: [user('Warmup please')] }),
    null,
  )
  assert.equal(
    detectWarmupIntercept({ model: 'claude-opus-5-5', messages: [user('hi')], tools: [{ name: 'Bash' }] }),
    null,
  )
})

test('mock JSON matches sub2api shapes', () => {
  const ping = warmupMockMessage('haiku_ping', 'claude-haiku-4-5')
  assert.equal(ping.content[0].text, '#')
  assert.equal(ping.stop_reason, 'max_tokens')
  assert.equal(ping.usage.input_tokens, 10)
  assert.match(ping.id, /^msg_01/)
  assert.equal(warmupMockMessage('warmup', 'm').content[0].text, 'New Conversation')
  assert.equal(warmupMockMessage('suggestion', 'm').content[0].text, '')
})

test('streaming haiku ping keeps "#" and max_tokens', () => {
  const sse = formatWarmupSse('haiku_ping', 'claude-haiku-4-5')
  const events = sse
    .split('\n')
    .filter((l) => l.startsWith('event: '))
    .map((l) => l.slice(7))
  assert.deepEqual(events, [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  const data = sse
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
  assert.equal(data[2].delta.text, '#')
  assert.equal(data[4].delta.stop_reason, 'max_tokens')
})

test('intercept_warmup defaults on and can be turned off', () => {
  assert.equal(normalizeHealthProbeConfig({}).intercept_warmup, true)
  assert.equal(normalizeHealthProbeConfig({ intercept_warmup: false }).intercept_warmup, false)
})
