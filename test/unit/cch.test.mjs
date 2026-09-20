import { test } from 'node:test'
import assert from 'node:assert/strict'
import { xxh64 } from '../../src/lib/identity/xxh64.mjs'
import {
  CCH_PLACEHOLDER,
  CCH_XXH64_SEED,
  computeClaudeCodeCch,
  sealClaudeCodeCch,
} from '../../src/lib/identity/cch.mjs'
import { buildBillingAttributionText, applyCrsUnofficialPersona } from '../../src/lib/identity/crs-persona.mjs'
import { finalizeWorkerPayload } from '../../src/lib/transport/go-worker-client.mjs'

test('xxh64 matches Python xxhash.xxh64 intdigest vectors', () => {
  const seed = CCH_XXH64_SEED
  assert.equal(xxh64(Buffer.alloc(0), 0n), 0xef46db3751d8e999n)
  assert.equal(xxh64(Buffer.from('a'), 0n), 0xd24ec4f1a98c6e5bn)
  assert.equal(xxh64(Buffer.from('abc'), 0n), 0x44bc2cf5ad770999n)
  assert.equal(xxh64(Buffer.from('abc'), seed), 0xceea2ac52c48cf48n)
  assert.equal(xxh64(Buffer.from('hello'), seed), 0x95ab2f66e009922an)
  assert.equal(xxh64(Buffer.from('0123456789abcdef0123456789abcdef'), 0n), 0x642a94958e71e6c5n)
  assert.equal(xxh64(Buffer.from('0123456789abcdef0123456789abcdefXXXX'), seed), 0x4c973d996ffff8b2n)
  assert.equal(xxh64(Buffer.from('{"x":"cch=00000"}'), seed), 0x93c1b70107051e6n)
})

test('computeClaudeCodeCch is xxh64(body, official seed) & 0xfffff as 5 hex', () => {
  const raw = Buffer.from('{"x":"cch=00000"}')
  assert.equal(computeClaudeCodeCch(raw), '051e6')
  assert.equal(computeClaudeCodeCch(Buffer.from('hello')), '9922a')
})

test('buildBillingAttributionText leaves cch=00000 for later seal', () => {
  const text = buildBillingAttributionText('hello', '2.1.263', 's-1')
  assert.match(text, new RegExp(`cch=${CCH_PLACEHOLDER};`))
  assert.doesNotMatch(text, /cch=(?!00000)[0-9a-f]{5}/)
})

test('sealClaudeCodeCch hashes compact JSON with placeholder then writes digest', () => {
  const body = {
    model: 'claude-sonnet-5',
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.263.abc; cc_entrypoint=sdk-cli; cch=00000; cc_prompt_id=00000000-0000-4000-8000-000000000000;',
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const raw = JSON.stringify(body)
  assert.match(raw, /cch=00000/)
  const expected = computeClaudeCodeCch(Buffer.from(raw, 'utf8'))
  const sealed = sealClaudeCodeCch(body)
  assert.equal(expected.length, 5)
  assert.notEqual(expected, CCH_PLACEHOLDER)
  assert.match(sealed.system[0].text, new RegExp(`cch=${expected};`))
  assert.equal(JSON.stringify(sealed), raw.replace(/cch=00000/, `cch=${expected}`))
})

test('sealClaudeCodeCch is a no-op when billing already has a real cch', () => {
  const body = {
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=2.1.241.abc; cc_entrypoint=cli; cch=cc746;',
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  }
  const sealed = sealClaudeCodeCch(body)
  assert.equal(sealed.system[0].text, body.system[0].text)
  assert.equal(sealed, body)
})

test('applyCrsUnofficialPersona keeps the placeholder until hop finalize', () => {
  const out = applyCrsUnofficialPersona({
    messages: [{ role: 'user', content: 'ping' }],
  })
  assert.match(out.system[0].text, new RegExp(`cch=${CCH_PLACEHOLDER};`))
  const sealed = finalizeWorkerPayload({
    body: out,
    reqHeaders: {},
    exec: { homeDir: '', vm: { claude: { mode: 'setup-token', scope: 'user:inference' } } },
    identity: null,
  }).body
  const cch = sealed.system[0].text.match(/cch=([0-9a-f]{5})/)[1]
  assert.notEqual(cch, CCH_PLACEHOLDER)
  const replay = JSON.stringify(sealed).replace(`cch=${cch}`, `cch=${CCH_PLACEHOLDER}`)
  assert.equal(computeClaudeCodeCch(Buffer.from(replay, 'utf8')), cch)
})
