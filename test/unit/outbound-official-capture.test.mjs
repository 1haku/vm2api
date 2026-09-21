/** Snapshot of unofficial mimicry header/body shape against official Claude Code 2.1.278. */
/** Captured from the official Linux x64 binary with no tokens. */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCrsUnofficialPersona,
  CRS_OFFICIAL_SYSTEM,
  CRS_AGENT_EXPANSION,
  AGENT_EXPANSION_CACHE_CONTROL,
} from '../../src/lib/identity/crs-persona.mjs'
import { prepareOutboundEnvelope } from '../../src/lib/protocol/outbound-attempt.mjs'
import { fullClaudeCodeMimicryBetas } from '../../src/lib/protocol/claude-code-betas.mjs'

const CAPTURE_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'thinking-binding-controls-2026-08-01',
  'mid-conversation-tool-changes-2026-07-01',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
]

test('unofficial outbound envelope matches official 2.1.278 capture keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cap-'))
  const identity = {
    vmId: 'vm-29',
    deviceId: 'd'.repeat(64),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    timezone: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    kernel: '7.0.0-14-generic',
    userAgent: 'claude-cli/2.1.278 (external, sdk-cli)',
    fingerprint: {
      x_app: 'cli',
      stainless_lang: 'js',
      stainless_os: 'Linux',
      stainless_arch: 'x64',
      stainless_runtime: 'node',
      stainless_runtime_version: 'v26.3.0',
      stainless_package_version: '0.112.1',
      locale: 'en_US.UTF-8',
      timezone: 'America/Los_Angeles',
      os_pretty: 'Ubuntu 24.04',
      kernel_release: '7.0.0-14-generic',
    },
  }
  const inbound = {
    model: 'claude-sonnet-5',
    max_tokens: 128000,
    stream: true,
    messages: [{ role: 'user', content: 'search apple' }],
    metadata: { user_id: JSON.stringify({ session_id: 'user-sess-capture' }) },
  }
  const headersIn = { 'user-agent': 'RikkaHub/1.0', 'x-session-id': 'user-sess-capture' }
  const persona = applyCrsUnofficialPersona(inbound, {
    officialClient: false,
    mode: 'rewrite',
    sessionId: 'user-sess-capture',
    identity,
    model: inbound.model,
  })
  const envelope = prepareOutboundEnvelope({
    canonicalBody: persona,
    inbound,
    identity,
    unofficial: true,
    stream: true,
    reqHeaders: headersIn,
    homeDir: dir,
  })
  const { headers, body } = envelope
  assert.equal(headers['user-agent'], 'claude-cli/2.1.278 (external, sdk-cli)')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers['x-app'], 'cli')
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true')
  assert.equal(headers['x-stainless-lang'], 'js')
  assert.equal(headers['x-stainless-os'], 'Linux')
  assert.equal(headers['x-stainless-arch'], 'x64')
  assert.equal(headers['x-stainless-runtime'], 'node')
  assert.equal(headers['x-stainless-runtime-version'], 'v26.3.0')
  assert.equal(headers['x-stainless-package-version'], '0.112.1')
  assert.equal(headers['x-stainless-retry-count'], '0')
  assert.equal(headers['x-stainless-timeout'], '600')
  assert.equal(headers.accept, 'text/event-stream')
  assert.deepEqual(String(headers['anthropic-beta'] || '').split(','), CAPTURE_BETAS)
  assert.deepEqual(fullClaudeCodeMimicryBetas(), CAPTURE_BETAS)
  assert.doesNotMatch(String(headers['anthropic-beta'] || ''), /context-1m/)
  const uid = JSON.parse(body.metadata.user_id)
  assert.equal(uid.device_id, identity.deviceId)
  assert.equal(uid.account_uuid, identity.accountUuid)
  assert.notEqual(uid.session_id, 'user-sess-capture')
  assert.match(uid.session_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(uid.email, undefined)
  assert.equal(headers['x-claude-code-session-id'], uid.session_id)
  assert.equal(body.model, 'claude-sonnet-5')
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 128000)
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'omitted' })
  assert.equal(body.output_config.effort, 'high')
  assert.equal(body.context_management.edits[0].type, 'clear_thinking_20251015')
  assert.equal(body.system.length, 4)
  assert.match(body.system[0].text, /cc_entrypoint=sdk-cli;/)
  assert.match(body.system[0].text, /cch=/)
  assert.match(body.system[0].text, /cc_prompt_id=/)
  assert.equal(body.system[1].text, CRS_OFFICIAL_SYSTEM)
  assert.equal(body.system[2].text, CRS_AGENT_EXPANSION)
  assert.deepEqual(body.system[2].cache_control, AGENT_EXPANSION_CACHE_CONTROL)
  assert.match(body.system[3].text, /# Environment/)
  assert.ok(!body.system[3].text.includes('Linux 7.0.0-14-generic'))
  assert.match(body.system[3].text, /Timezone: America\/Los_Angeles/)
  assert.ok(!body.system[3].text.includes('Locale:'))
  assert.ok(!body.system[3].text.includes('Platform: linux'))
  assert.ok(!body.system[3].text.includes('OS Version:'))
  assert.equal(body.system[3].cache_control, undefined)
  assert.equal(Array.isArray(body.tools) && body.tools.some((t) => t.name === 'Agent'), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('inbound claude-sonnet-5[1m] injects 1M beta and strips outbound model', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-1m-'))
  const identity = {
    vmId: 'vm-29',
    deviceId: 'd'.repeat(64),
    accountUuid: '11111111-1111-4111-8111-111111111111',
    timezone: 'America/Los_Angeles',
    userAgent: 'claude-cli/2.1.241 (external, sdk-cli)',
    fingerprint: { locale: 'en_US.UTF-8', timezone: 'America/Los_Angeles' },
  }
  const envelope = prepareOutboundEnvelope({
    canonicalBody: {
      model: 'claude-sonnet-5',
      max_tokens: 128000,
      messages: [{ role: 'user', content: 'hi' }],
    },
    inbound: { model: 'claude-sonnet-5[1m]', max_tokens: 128000, messages: [{ role: 'user', content: 'hi' }] },
    identity,
    unofficial: true,
    stream: true,
    reqHeaders: { 'user-agent': 'Go-http-client/2.0' },
    homeDir: dir,
  })
  assert.equal(envelope.body.model, 'claude-sonnet-5')
  assert.match(String(envelope.headers['anthropic-beta'] || ''), /context-1m-2025-08-07/)
  fs.rmSync(dir, { recursive: true, force: true })
})
