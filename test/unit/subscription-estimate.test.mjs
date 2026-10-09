import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateSubscriptionInput } from '../../src/lib/admin/subscription-estimate.mjs'

test('image and opaque reasoning encodings do not inflate prompt tokens with their byte size', () => {
  const request = (size) => ({
    model: 'gpt-6-astra',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect this screenshot' },
          { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(size) },
        ],
      },
      { type: 'reasoning', encrypted_content: 'B'.repeat(size), summary: [] },
    ],
  })
  const small = estimateSubscriptionInput(request(100))
  const large = estimateSubscriptionInput(request(3_200_000))
  assert.deepEqual(large, small)
  assert.ok(large.media_tokens > 0)
  assert.ok(large.opaque_tokens > 0)
  assert.ok(large.tokens < 50000)
})

test('real text, tool schemas and tool arguments contribute; metadata and signatures do not', () => {
  const base = { messages: [{ role: 'user', content: 'hello' }] }
  const ordinary = estimateSubscriptionInput(base).tokens
  assert.equal(estimateSubscriptionInput({ ...base, metadata: { padding: 'x'.repeat(1_000_000) } }).tokens, ordinary)
  for (const field of [
    { tools: [{ type: 'function', function: { name: 'search', description: 'x'.repeat(100000) } }] },
    { input: [{ type: 'function_call', arguments: 'x'.repeat(100000) }] },
    {
      input: [{ type: 'function_call_output', output: { type: 'input_image', encrypted_content: 'x'.repeat(100000) } }],
    },
    { messages: [{ role: 'user', content: '中文测试'.repeat(25000) }] },
  ])
    assert.ok(estimateSubscriptionInput({ ...base, ...field }).tokens > ordinary + 30000)
  assert.ok(estimateSubscriptionInput({ input: 'x'.repeat(1_000_000) }).tokens > 272000)
  assert.ok(estimateSubscriptionInput({ previous_response_id: 'resp_1', input: 'hi' }).opaque_tokens > 0)
})

test('Anthropic images, redacted thinking, documents and audio receive explicit allowances', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', data: 'A'.repeat(3_000_000) } },
          { type: 'document', source: { type: 'text', data: 'hello document'.repeat(1000) } },
          { type: 'input_file', file_data: 'data:application/pdf;base64,' + 'A'.repeat(1_000_000) },
          { type: 'input_audio', input_audio: { data: 'A'.repeat(1_000_000) } },
          { type: 'redacted_thinking', data: 'X'.repeat(1_000_000) },
        ],
      },
    ],
  }
  const original = JSON.stringify(body)
  const result = estimateSubscriptionInput(body)
  assert.ok(result.tokens < 150000)
  assert.ok(result.text_bytes > 10000)
  assert.ok(result.media_tokens > 0 && result.opaque_tokens > 0)
  assert.equal(JSON.stringify(body), original)
})
