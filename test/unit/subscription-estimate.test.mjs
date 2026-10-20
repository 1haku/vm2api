import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateSubscriptionInput,
  estimateSubscriptionReservationInput,
} from '../../src/lib/admin/subscription-estimate.mjs'
import { setPriceCatalogTestHooks } from '../../src/lib/admin/price-catalog.mjs'

test('Responses multimodal tool outputs count media separately, without interpreting arbitrary tool JSON', () => {
  for (const type of ['custom_tool_call_output', 'function_call_output']) {
    const body = (size) => ({
      input: [
        {
          type,
          output: [
            { type: 'input_text', text: 'Screenshot from the test runner' },
            { type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(size) },
            { type: 'input_file', file_data: 'data:application/pdf;base64,' + 'B'.repeat(size) },
          ],
        },
      ],
    })
    const small = estimateSubscriptionInput(body(100))
    const large = estimateSubscriptionInput(body(2_000_000))
    assert.deepEqual(large, small)
    assert.equal(large.media_tokens, 8192 + 32768)
    const json = { type: 'input_image', encrypted_content: 'C'.repeat(100_000) }
    assert.ok(estimateSubscriptionInput({ input: [{ type, output: json }] }).text_bytes > 100_000)
    assert.ok(estimateSubscriptionInput({ input: [{ type, output: [json] }] }).text_bytes > 100_000)
    assert.ok(estimateSubscriptionInput({ input: [{ type: 'function_call', arguments: json }] }).text_bytes > 100_000)
  }
})

test('only a known published context bounds reservation tokens; caller limits cannot lower it', (t) => {
  const snapshot = { openai: { 'gpt-6-astra': { context: 1_050_000 } } }
  setPriceCatalogTestHooks({
    settings: { get: (key, fallback) => (key === 'price_catalog_modelsdev' ? snapshot : fallback) },
    backgroundRefresh: false,
  })
  t.after(() => setPriceCatalogTestHooks(null))
  const body = { model: 'openai/gpt-6-astra', input: 'long transcript '.repeat(200_000), context_window: 1 }
  const input = estimateSubscriptionReservationInput(body)
  assert.ok(input.raw_tokens > input.tokens)
  assert.equal(input.tokens, 1_050_000)
  assert.equal(input.context_limit, 1_050_000)
  assert.equal(input.capped, true)
  assert.equal(body.input.length, 3_200_000)
  const small = estimateSubscriptionReservationInput({ model: body.model, input: 'hi' })
  assert.equal(small.tokens, small.raw_tokens)
  assert.equal(small.capped, false)
  for (const context of [undefined, null, 0, -1, 1.5, 'invalid']) {
    snapshot.openai['gpt-6-astra'].context = context
    const unbounded = estimateSubscriptionReservationInput(body)
    assert.equal(unbounded.tokens, unbounded.raw_tokens)
    assert.equal(unbounded.context_limit, null)
  }
  const unknown = estimateSubscriptionReservationInput({ ...body, model: 'unknown-model' })
  assert.equal(unknown.tokens, unknown.raw_tokens)
})

test('large image/opaque encodings stay bounded and short reasoning does not pay an 8192-token flat charge', () => {
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
  assert.equal(large.media_tokens, small.media_tokens)
  assert.equal(large.text_tokens, small.text_tokens)
  assert.equal(small.opaque_tokens, 256)
  assert.equal(large.opaque_tokens, 8192)
  assert.equal(estimateSubscriptionInput(request(6_400_000)).tokens, large.tokens)
  assert.ok(large.tokens < 50000)
})

test('OpenAI text is tokenized locally with headroom, including literal special tokens and tool data', () => {
  const plain = estimateSubscriptionInput({ model: 'gpt-6-astra', input: 'hello world' })
  assert.equal(plain.method, 'o200k_estimate')
  assert.equal(plain.text_tokens, 2)
  assert.equal(plain.fallback_bytes, 0)
  assert.ok(estimateSubscriptionInput({ model: 'gpt-6-astra', input: '<|endoftext|> 中文 😀' }).text_tokens > 2)
  const code = 'const result = await fetch(url);\n'.repeat(10000)
  const estimate = estimateSubscriptionInput({ model: 'gpt-6-astra', input: code })
  const old = estimateSubscriptionInput({ input: code })
  assert.ok(estimate.tokens < old.tokens * 0.85)
  const argumentsEstimate = estimateSubscriptionInput({
    model: 'gpt-6-astra',
    input: [{ type: 'function_call', arguments: { type: 'input_image', data: code } }],
  })
  assert.ok(argumentsEstimate.text_tokens >= estimate.text_tokens)
  assert.equal(argumentsEstimate.media_tokens, 0)
})

test('long replay uses envelope allowances, retains all visible text and leaves the request untouched', () => {
  const input = Array.from({ length: 120 }, () => ({
    type: 'reasoning',
    encrypted_content: 'A'.repeat(684),
    summary: [{ type: 'summary_text', text: 'reasoning summary' }],
  }))
  input.push({ role: 'user', content: 'Review the code. '.repeat(6000) })
  const body = { model: 'gpt-6-astra', input }
  const before = JSON.stringify(body)
  const result = estimateSubscriptionInput(body)
  assert.equal(result.opaque_tokens, 120 * 513)
  assert.ok(result.text_tokens > 20000)
  assert.ok(result.tokens < 150000, 'short reasoning envelopes must not fabricate a million-token prompt')
  assert.equal(JSON.stringify(body), before)
  assert.equal(
    estimateSubscriptionInput({ model: body.model, input: [{ type: 'reasoning', encrypted_content: 'invalid!' }] })
      .opaque_tokens,
    8192,
  )
})

test('huge/adversarial text has bounded tokenizer work and a conservative fallback, not free tokens', () => {
  const body = { model: 'gpt-6-astra', input: 'x'.repeat(2_000_000) }
  const result = estimateSubscriptionInput(body)
  assert.equal(result.fallback_bytes, 1_000_000)
  assert.ok(result.tokens > 500000)
  const unicode = estimateSubscriptionInput({ model: body.model, input: 'x'.repeat(2047) + '😀'.repeat(2048) })
  assert.equal(unicode.fallback_bytes, 0)
  assert.ok(unicode.text_tokens >= 2048)
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
