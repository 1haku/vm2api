import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'

test('Messages route forwards cache warming through interception and keeps the output cap', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-cache-warmer-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const routingFile = path.join(root, 'routing.json')
  const compatibility = { persona_preset: 'zero', min_max_tokens: { enabled: true, value: 128 } }
  fs.writeFileSync(routingFile, JSON.stringify({ compatibility }))
  const vm = { id: 'vm-01', claude: { mode: 'oauth' } }
  const selected = {
    vmId: vm.id,
    accountId: 'account-1',
    vm,
    exec: { vmId: vm.id, vm, homeDir: path.join(root, 'home'), oauth: { account_uuid: 'account-1' } },
  }
  let inbound
  const prepared = []
  const response = { headersSent: false, on() {}, once() {}, off() {}, write() {}, end() {} }
  const handler = createHandleProtocol({
    json: (_res, status, body) => {
      response.status = status
      response.body = body
    },
    writeSSEHeaders() {},
    readBody: async () => inbound,
    requireAuth: () => true,
    cfg: {
      rewrite: { enabled: false },
      intercept: { rules: [] },
      distill: { enabled: false },
      limits: { max_body_bytes: 1024 * 1024, upstream_timeout_ms: 2000 },
      paths: { data: root, project: root },
    },
    requestLog: { start: () => ({ request_id: 'cache-warmer-test' }), finish() {} },
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    accountQuota: {},
    apiKeyStore: {},
    apiScheduler: {},
    apiEndpointStore: {},
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    routingConfigPath: routingFile,
    routingConfig: { compatibility, failover: {} },
    healthMonitor: { getConfig: () => ({ intercept_warmup: true }) },
    failoverRunner: {
      async run(opts) {
        prepared.push(await opts.applyAttempt(opts.canonicalBody, selected))
        return {
          ok: false,
          status: 503,
          body: { error: { type: 'server_error', code: 'upstream_error', message: 'fixture upstream unavailable' } },
          headers: {},
        }
      },
    },
    groupsRepo: { rateMultiplier: () => 1 },
  })
  const req = {
    method: 'POST',
    url: '/v1/messages',
    apiKeyKind: 'master',
    headers: { authorization: 'Bearer fixture', 'user-agent': 'claude-cli/2.1.281 (external, cli)' },
    once() {},
    off() {},
  }
  const base = {
    model: 'claude-haiku-4-5',
    max_tokens: 1,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Respond with only: OK' }] }],
  }
  for (const [index, prompt] of ['Respond with only: OK', 'Warmup'].entries()) {
    inbound = {
      ...base,
      system: [{ type: 'text', text: 'Pinned prefix', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    }
    await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
    assert.equal(response.status, 503, 'surface the real upstream failure instead of mock success')
    assert.equal(prepared.length, index + 1)
    assert.equal(prepared[index].body.max_tokens, 1)
    assert.equal(prepared[index].body.messages.at(-1).content.at(-1).cache_control.ttl, '1h')
  }
  inbound = base
  await handler.handleProtocol(req, response, 'anthropic.messages', '/v1/messages')
  assert.equal(response.status, 200)
  assert.equal(response.body.content[0].text, '#')
  assert.equal(prepared.length, 2, 'ordinary unmarked Haiku probe still avoids upstream')
})
