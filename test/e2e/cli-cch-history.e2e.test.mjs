import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { startRealChain } from './helpers/real-chain.mjs'
import { sealClaudeCodeCch } from '../../src/lib/identity/cch.mjs'

const root = path.resolve(import.meta.dirname, '../..')

function withoutMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutMarkers)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, nested]) => [key, withoutMarkers(nested)]),
  )
}

test('CLI seals system billing without changing quoted billing in growing history', { timeout: 60000 }, async (t) => {
  const chain = await startRealChain({
    kernelBin: process.env.KIN_CCH_KERNEL || path.join(root, 'bin/kin-kernel'),
    cliBin: process.env.KIN_CCH_CLI || path.join(root, 'share/wrap-cli/cli-node'),
    preset: 'official',
    cacheTtl: '1h',
  })
  t.after(() => chain.close())

  const literal = 'x-anthropic-billing-header: cc_version=2.8.4; cc_entrypoint=sdk-cli; cch=259ed;'
  const body = {
    model: 'claude-opus-5-5',
    max_tokens: 128,
    stream: true,
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.296; cc_entrypoint=sdk-cli; cch=00000;' },
      { type: 'text', text: 'Preserve the fixture and continue the conversation.' },
    ],
    tools: [{ name: 'Read', description: 'Read a fixture', input_schema: { type: 'object', properties: {} } }],
    messages: [
      { role: 'user', content: 'Read the fixture.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read_fixture', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read_fixture', content: literal }] },
    ],
  }

  let previous = []
  for (let turn = 0; turn < 3; turn++) {
    if (turn)
      body.messages.push({ role: 'assistant', content: 'Done.' }, { role: 'user', content: `Continue ${turn}.` })
    const result = await chain.send({
      source: { protocol: 'anthropic.messages' },
      request: { path: '/v1/messages', headers: { 'user-agent': 'cache-history-fixture' }, body },
    })
    assert.equal(result.status, 200)
    assert.equal(result.count, 1)
    assert.equal(result.body.messages[2].content[0].content, literal)
    assert.deepEqual(withoutMarkers(result.body.messages.slice(0, previous.length)), withoutMarkers(previous))

    const billing = result.body.system.find((block) => /^x-anthropic-billing-header:/i.test(block.text || ''))
    assert.ok(billing)
    assert.equal((billing.text.match(/\bcch=/g) || []).length, 1)
    const resealed = sealClaudeCodeCch(result.body)
    assert.deepEqual(resealed.messages, result.body.messages)
    assert.deepEqual(
      resealed.system,
      result.body.system,
      'CLI digest must match final-body CCH, not a session constant',
    )
    previous = result.body.messages
  }
})
