import test from 'node:test'
import assert from 'node:assert/strict'
import { isClaudeCodeFamilyRequest } from '../../src/lib/identity/claude-code-only.mjs'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { handleUserCountTokens } from '../../src/lib/protocol/user-count-tokens.mjs'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'

const CLI_UA = 'claude-cli/2.1.293 (external, cli)'
const SESSION = '11111111-2222-4333-8444-555555555555'
const USER_ID = JSON.stringify({ device_id: 'd'.repeat(64), session_id: SESSION })
const BILLING = 'x-anthropic-billing-header: cc_version=2.1.293.9; cc_entrypoint=cli; cch=ab;'
// Header set a real 2.1.280 CLI sent on both /v1/messages and count_tokens.
const CLI_HEADERS = {
  'user-agent': CLI_UA,
  'x-app': 'cli',
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'claude-code-20250219,interleaved-thinking-2025-05-14',
  'x-stainless-lang': 'js',
  'x-stainless-runtime': 'node',
  'x-stainless-package-version': '0.112.1',
  'x-claude-code-session-id': SESSION,
}
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

test('Claude Code family recognition needs the full client fingerprint, not the UA', () => {
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, OFFICIAL_BODY), true)
  // UA plus a copied official body is not enough without the client header set.
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, OFFICIAL_BODY), false)
  for (const key of ['x-app', 'anthropic-beta', 'x-stainless-lang', 'x-claude-code-session-id']) {
    const { [key]: _drop, ...partial } = CLI_HEADERS
    assert.equal(isClaudeCodeFamilyRequest(partial, OFFICIAL_BODY), false, key)
  }
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, THIRD_PARTY_BODY), false)
  // Header session and metadata.user_id session come from the same CLI value.
  const otherSession = { ...CLI_HEADERS, 'x-claude-code-session-id': '99999999-2222-4333-8444-555555555555' }
  assert.equal(isClaudeCodeFamilyRequest(otherSession, OFFICIAL_BODY), false)
  // Billing cc_version and UA version come from the same build.
  const otherVersion = { ...CLI_HEADERS, 'user-agent': 'claude-cli/2.1.280 (external, cli)' }
  assert.equal(isClaudeCodeFamilyRequest(otherVersion, OFFICIAL_BODY), false)
  // A relayed official body is as easy to forge as a spoofed one.
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': 'Go-http-client/1.1' }, OFFICIAL_BODY), false)
})

test('Claude Code family recognition: no UA-only probe or count_tokens exceptions', () => {
  const probe = { model: 'claude-sonnet-5', max_tokens: 1, messages: [{ role: 'user', content: 'quota' }] }
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, probe), false)
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, probe), false)

  const count = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, count, { countTokens: true }), true)
  assert.equal(isClaudeCodeFamilyRequest({ 'user-agent': CLI_UA }, count, { countTokens: true }), false)
  const ohMyPi = { ...count, system: 'x\ncc_entrypoint=local-agent\n' }
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, ohMyPi, { countTokens: true }), false)
})

const REACHED = new Error('reached-scheduler')

function protocolHarness({ routing, body, healthMonitor }) {
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
    getHealthMonitor: () => healthMonitor,
  })
  return { handler, response }
}

async function runProtocol({ routing, body, headers, protocol = 'anthropic.messages', healthMonitor }) {
  const { handler, response } = protocolHarness({ routing, body, healthMonitor })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: 'Bearer master', 'x-kin-backend': 'api', ...headers },
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

const AXIOS = { 'user-agent': 'axios/1.7' }
const BLOCKED = { reached: false, status: 403, code: 'claude_code_only' }

test('switch on: third-party Claude requests are 403 before any account is picked', async () => {
  assert.deepEqual(await runProtocol({ routing: ON, body: THIRD_PARTY_BODY, headers: AXIOS }), BLOCKED)
  // A spoofed UA on a copied official body is still third-party.
  const spoofed = await runProtocol({ routing: ON, body: OFFICIAL_BODY, headers: { 'user-agent': CLI_UA } })
  assert.deepEqual(spoofed, BLOCKED)
  // Official Claude Code never uses the OpenAI Chat entry, even with its headers.
  const chat = await runProtocol({ routing: ON, body: OFFICIAL_BODY, headers: CLI_HEADERS, protocol: 'openai.chat' })
  assert.deepEqual(chat, BLOCKED)
})

test('switch on: health probes are refused, never answered from the probe cache', async () => {
  const seen = []
  const healthMonitor = {
    decide: () => {
      seen.push('decide')
      return { action: 'fail', via: 'health-fail', snapshot: {} }
    },
  }
  assert.deepEqual(await runProtocol({ routing: ON, body: THIRD_PARTY_BODY, headers: AXIOS, healthMonitor }), BLOCKED)
  // sub2api's account test carries the CLI banner; even with a full CLI header set it is a probe.
  const accountTest = {
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    temperature: 1,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    metadata: { user_id: USER_ID },
    messages: [{ role: 'user', content: 'hi' }],
  }
  assert.equal(isClaudeCodeFamilyRequest(CLI_HEADERS, accountTest), true)
  assert.deepEqual(await runProtocol({ routing: ON, body: accountTest, headers: CLI_HEADERS, healthMonitor }), BLOCKED)
  assert.deepEqual(seen, [])
})

test('switch on: official Claude Code reaches the scheduler', async () => {
  const result = await runProtocol({ routing: ON, body: OFFICIAL_BODY, headers: CLI_HEADERS })
  assert.equal(result.reached, true)
})

test('switch on: master-key pinned panel diagnostics are not inbound clients', async () => {
  const result = await runProtocol({ routing: ON, body: THIRD_PARTY_BODY, headers: { ...AXIOS, 'x-kin-vm': 'vm-01' } })
  assert.equal(result.reached, true)
})

test('switch off: third-party Claude requests are not gated', async () => {
  const result = await runProtocol({ routing: {}, body: THIRD_PARTY_BODY, headers: AXIOS })
  assert.equal(result.reached, true)
})

test('switch on: GPT models are never gated', async () => {
  const result = await runProtocol({
    routing: ON,
    body: { model: 'gpt-5.5', input: 'hi' },
    headers: AXIOS,
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
  for (const headers of [AXIOS, { 'user-agent': CLI_UA }]) {
    const third = countTokensDeps(ON, 'claude-sonnet-5')
    await handleUserCountTokens({ headers }, {}, third.deps)
    assert.equal(third.seen.status, 403)
    assert.equal(third.seen.body.error.code, 'claude_code_only')
    assert.equal(third.seen.peeked, 0)
  }

  const cli = countTokensDeps(ON, 'claude-sonnet-5')
  await handleUserCountTokens({ headers: CLI_HEADERS }, {}, cli.deps)
  assert.equal(cli.seen.status, 200)

  const gpt = countTokensDeps(ON, 'gpt-5.5')
  await handleUserCountTokens({ headers: AXIOS }, {}, gpt.deps)
  assert.equal(gpt.seen.peeked, 1)
})

test('routing patch rejects a non-boolean claude_code_only', () => {
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { claude_code_only: true } }), [])
  assert.deepEqual(validatePersonaRoutingPatch({ compatibility: { claude_code_only: 'yes' } }), [
    'claude_code_only 必须是布尔',
  ])
})
