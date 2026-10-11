import test from 'node:test'
import assert from 'node:assert/strict'
import { isClaudeCodeFamilyRequest } from '../../src/lib/identity/claude-code-only.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'

const CLI_UA = 'claude-cli/2.1.293 (external, cli)'
const USER_ID = JSON.stringify({ device_id: 'd'.repeat(64), session_id: '11111111-2222-4333-8444-555555555555' })
const BILLING = 'x-anthropic-billing-header: cc_version=2.1.293.9; cc_entrypoint=cli; cch=ab;'
const OFFICIAL_BODY = {
  model: 'claude-sonnet-5',
  max_tokens: 32000,
  system: [
    { type: 'text', text: BILLING },
    { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." },
  ],
  metadata: { user_id: USER_ID },
  messages: [{ role: 'user', content: 'hi' }],
}
const THIRD_PARTY_BODY = {
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: 'hi' }],
}
const ON = { compatibility: { claude_code_only: true } }

test('Claude Code family recognition: official, proxied, probes, and spoofed UA', () => {
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, OFFICIAL_BODY), true)
  // Spoofed UA alone does not make a third-party body official.
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, THIRD_PARTY_BODY), false)

  const relayed = { 'user-agent': 'Go-http-client/1.1' }
  assert.equal(isClaudeCodeFamilyRequest(relayed, OFFICIAL_BODY, { routing: {} }), true)
  assert.equal(
    isClaudeCodeFamilyRequest(relayed, OFFICIAL_BODY, {
      routing: { compatibility: { detect_proxied_official_cc: false } },
    }),
    false,
  )

  const probe = { model: 'claude-sonnet-5', max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, probe), true)
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': 'axios/1.7' }, probe), false)

  const count = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, count, { countTokens: true }), true)
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, count), false)
  const ohMyPi = { ...count, system: 'x\ncc_entrypoint=local-agent\n' }
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, ohMyPi, { countTokens: true }), false)
})

const REACHED = new Error('reached-scheduler')

function protocolHarness({ routing, body }) {
  const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
  const stats = { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 }
  const handler = createHandleProtocol({
    json: (_res, status, payload) => {
      response.status = status
      response.body = payload
      return payload
    },
    writeSSEHeaders() {},
    readBody: async () => structuredClone(body),
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: {},
    },
    requestLog: { start: () => ({ request_id: 'cc-only-test' }), finish() {} },
    stickyRouter: {},
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {
      pick: () => {
        throw REACHED
      },
    },
    apiEndpointStore: {},
    stats,
    getRoutingConfig: () => routing,
    groupsRepo: { rateMultiplier: () => 1 },
  })
  return { handler, response }
}

async function runProtocol({ routing, body, ua, protocol = 'anthropic.messages' }) {
  const { handler, response } = protocolHarness({ routing, body })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer master', 'x-kin-backend': 'api', 'user-agent': ua },
    apiKeyKind: 'master',
    once() {},
    off() {},
  }
  let reached = false
  try {
    await handler.handleProtocol(req, response, protocol, '/v1/messages')
  } catch (error) {
    if (error !== REACHED) throw error
    reached = true
  }
  return { reached, status: response.status, code: response.body?.error?.code }
}

test('switch on: third-party Claude requests are 403 before any account is picked', async () => {
  const blocked = await runProtocol({ routing: ON, body: THIRD_PARTY_BODY, ua: 'axios/1.7' })
  assert.deepEqual(blocked, { reached: false, status: 403, code: 'claude_code_only' })
  // Official Claude Code never uses the OpenAI Chat entry, even with its UA.
  const chat = await runProtocol({ routing: ON, body: OFFICIAL_BODY, ua: CLI_UA, protocol: 'openai.chat' })
  assert.deepEqual(chat, { reached: false, status: 403, code: 'claude_code_only' })
})

test('switch on: official Claude Code reaches the scheduler', async () => {
  const result = await runProtocol({ routing: ON, body: OFFICIAL_BODY, ua: CLI_UA })
  assert.equal(result.reached, true)
})

test('switch off: third-party Claude requests are not gated', async () => {
  const result = await runProtocol({ routing: {}, body: THIRD_PARTY_BODY, ua: 'axios/1.7' })
  assert.equal(result.reached, true)
})

test('switch on: GPT models are never gated', async () => {
  const result = await runProtocol({
    routing: ON,
    body: { model: 'gpt-5.5', input: 'hi' },
    ua: 'axios/1.7',
    protocol: 'openai.responses',
  }).catch(() => ({ code: null }))
  assert.notEqual(result.code, 'claude_code_only')
})

function countTokensDeps(routing, model) {
  const seen = { peeked: 0 }
  return {
    seen,
    deps: {
      json: (_res, status, body) => {
        seen.status = status
        seen.body = body
      },
      requireAuth: () => true,
      readBody: async () => ({ model, messages: [{ role: 'user', content: 'hi' }] }),
      cfg: { limits: { max_body_bytes: 4096 } },
      stickyRouter: { extractPoolKey: () => null },
      getRoutingConfig: () => routing,
      getPoolScheduler: () => ({
        peekAccount: async () => {
          seen.peeked++
          return { ok: true, vmId: 'vm-01', accountId: 'a', vm: { credential_mode: 'setup-token' }, exec: {} }
        },
      }),
      countTokensViaWorker: async () => ({ ok: true, status: 200, body: { input_tokens: 5 } }),
    },
  }
}

test('count_tokens: switch on blocks third-party Claude, admits the CLI and GPT models', async () => {
  const third = countTokensDeps(ON, 'claude-sonnet-5')
  await handleUserCountTokens({ headers: { 'user-agent': 'axios/1.7' } }, {}, third.deps)
  assert.equal(third.seen.status, 403)
  assert.equal(third.seen.body.error.code, 'claude_code_only')
  assert.equal(third.seen.peeked, 0)

  const cli = countTokensDeps(ON, 'claude-sonnet-5')
  await handleUserCountTokens({ headers: { 'user-agent': CLI_UA } }, {}, cli.deps)
  assert.equal(cli.seen.status, 200)

  const gpt = countTokensDeps(ON, 'gpt-5.5')
  await handleUserCountTokens({ headers: { 'user-agent': 'axios/1.7' } }, {}, gpt.deps)
  assert.equal(gpt.seen.peeked, 1)
})

test('routing patch rejects a non-boolean claude_code_only', () => {
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { claude_code_only: true } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { claude_code_only: 'yes' } }), [
    'claude_code_only 必须是布尔',
  ])
})
