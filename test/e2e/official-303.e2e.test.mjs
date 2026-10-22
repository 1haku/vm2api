/**
 * official_303 on the real chain: Node handler → kin-kernel ELF → cli-node ELF → local upstream.
 * Needs the binaries, so it is opt-in:
 *   KIN_303_KERNEL=<kin-kernel> KIN_303_CLI=<cli-node with profile mode>
 *   KIN_303_BASE_CLI=<cli-node before this change> (296 byte regression)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHandleProtocol } from '../../src/lib/protocol/handle-protocol.mjs'
import { createRespond, readBody } from '../../src/lib/http/respond.mjs'
import { rememberRustHealth, clearRustHealthCache } from '../../src/lib/transport/kernel-router.mjs'
import {
  OFFICIAL_303_ENV_UNTRUSTED,
  OFFICIAL_303_IDENTITY,
  OFFICIAL_303_MAIN_PROMPT,
  profileForPreset,
} from '../../src/lib/identity/official-profiles.mjs'
import {
  checkOfficial303Rules,
  diffShapes,
  isAllowedSkeletonDiff,
  outboundShape,
} from '../../src/lib/protocol/outbound-shape.mjs'
import { computeClaudeCodeCch, projectClaudeCodeCchText } from '../../src/lib/identity/cch.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const kernelBin = process.env.KIN_303_KERNEL || ''
const cliBin = process.env.KIN_303_CLI || ''
const baseCli = process.env.KIN_303_BASE_CLI || ''
const skip = !kernelBin || !cliBin || !fs.existsSync(kernelBin) || !fs.existsSync(cliBin)
const SKELETON = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/official-2.1.303-skeleton.json'), 'utf8'))

function unixRequest(socketPath, token, endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: endpoint, headers: { 'x-internal-token': token } }, (res) => {
      let text = ''
      res.on('data', (chunk) => {
        text += chunk
      })
      res.on('end', () => resolve(text))
    })
    req.on('error', reject)
    req.end()
  })
}

function sse(model) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_303',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

async function harness(t, { preset = 'official_303', cacheTtl = '5m', cli = cliBin } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-303-e2e-'))
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }))
  const captured = []
  const upstream = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (!req.url.startsWith('/v1/messages')) return res.writeHead(404).end()
    const body = JSON.parse(raw)
    captured.push({ raw, body, headers: { ...req.headers } })
    res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_303' })
    res.end(sse(body.model))
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
  })
  const socketPath = path.join(temp, 'kernel.sock')
  const token = 'local-303-token'
  const tokenPath = path.join(temp, 'internal.token')
  fs.writeFileSync(tokenPath, token)
  const homeDir = path.join(temp, 'cli-home')
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true })
  const credentialPath = path.join(homeDir, '.claude', 'credentials.json')
  fs.writeFileSync(credentialPath, JSON.stringify({ anthropicApiKey: { apiKey: 'local-fixture-key' } }))
  const configPath = path.join(temp, 'kernel.json')
  const kernelConfig = (presetNow) => ({
    vm_id: 'vm-01',
    socket_path: socketPath,
    credential_path: credentialPath,
    internal_token: token,
    provider: 'local_cli',
    claude_bin: cli,
    slots_per_worker: 2,
    system_layout: 'identity',
    persona_preset: presetNow,
    // Same projection as writeKernelConfig.
    cli_version: profileForPreset(presetNow).cliVersion,
    default_cache_ttl: cacheTtl,
    cch_enabled: true,
    timezone: 'America/New_York',
    test_endpoints: true,
    anthropic_base_url: `http://127.0.0.1:${upstream.address().port}`,
  })
  fs.writeFileSync(configPath, JSON.stringify(kernelConfig(preset)))
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: temp,
    ANTHROPIC_API_KEY: 'local-fixture-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    NO_PROXY: '127.0.0.1,localhost',
    KIN_ENVELOPE_PATH: path.join(temp, 'no-envelope.json'),
  }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_VERSION',
  ])
    delete env[key]
  const kernel = spawn(kernelBin, ['--gateway-worker', '--config', configPath], {
    cwd: temp,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const closed = once(kernel, 'close')
  let log = ''
  kernel.stdout.on('data', (c) => {
    log += c
  })
  kernel.stderr.on('data', (c) => {
    log += c
  })
  t.after(async () => {
    kernel.kill('SIGKILL')
    await closed
  })
  for (let i = 0; i < 100 && !fs.existsSync(socketPath) && kernel.exitCode == null; i++)
    await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(fs.existsSync(socketPath), log.slice(-1200))
  const health = JSON.parse(await unixRequest(socketPath, token, '/internal/health'))
  const vm = {
    id: 'vm-01',
    claude: { mode: 'api-key' },
    runtime: { kernel_socket: socketPath, worker_token_file: tokenPath, worker_run_dir: temp },
  }
  const exec = { vmId: vm.id, vm, homeDir, oauth: {}, timezone: 'UTC' }
  const routingPath = path.join(temp, 'routing.json')
  const writeRouting = (presetNow) => {
    const routing = {
      inference: { engine: 'rust', health_ttl_ms: 60000 },
      compatibility: {
        persona_preset: presetNow,
        cache_ttl: cacheTtl,
        min_max_tokens: 128,
        detect_proxied_official_cc: true,
        thinking_display: 'omitted',
        overlay_preset: 'off',
      },
      failover: { stream_keepalive_ms: 0 },
    }
    fs.writeFileSync(routingPath, JSON.stringify(routing))
    return routing
  }
  let routing = writeRouting(preset)
  const previousKernelBin = process.env.KIN_KERNEL_BIN
  process.env.KIN_KERNEL_BIN = kernelBin
  t.after(() => {
    if (previousKernelBin === undefined) delete process.env.KIN_KERNEL_BIN
    else process.env.KIN_KERNEL_BIN = previousKernelBin
  })
  rememberRustHealth(exec, { ok: true, health })
  t.after(() => clearRustHealthCache(vm.id))
  const cfg = {
    rewrite: { enabled: false },
    intercept: { rules: [] },
    distill: { enabled: false },
    limits: { max_body_bytes: 4 * 1024 * 1024, upstream_timeout_ms: 15000, stream_idle_timeout_ms: 15000 },
    paths: { project: temp, data: temp },
  }
  const logs = []
  const handler = createHandleProtocol({
    ...createRespond(cfg),
    readBody,
    cfg,
    requireAuth: () => true,
    requestLog: { start: () => ({ request_id: 'req_303_gateway' }), finish: (_ctx, bag) => logs.push(bag) },
    stats: { errors: 0, requests: 0, by_route: {}, passthrough: 0, rewrite: 0, convert: 0 },
    groupsRepo: { rateMultiplier: () => 1 },
    routingConfigPath: routingPath,
    routingConfig: routing,
    getRoutingConfig: () => routing,
    apiKeyStore: {},
    accountQuota: {},
    stickyRouter: { extractPoolKey: () => null, collectPoolKeys: () => [] },
    failoverRunner: {
      async run(opts) {
        const candidate = { vmId: vm.id, accountId: 'fixture-account', vm, exec }
        const prepared = await opts.applyAttempt(opts.canonicalBody, candidate)
        return opts.callAttempt({
          candidate,
          body: prepared.body,
          attemptMeta: prepared.meta,
          signal: opts.signal,
          deliveryMode: opts.deliveryMode,
          onCommit() {},
        })
      },
    },
  })
  const gateway = http.createServer((req, res) => {
    req.apiKeyKind = 'master'
    handler.handleProtocol(req, res, 'anthropic.messages', '/v1/messages').catch((error) => {
      res.writeHead(500)
      res.end(String(error.stack))
    })
  })
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    gateway.closeAllConnections()
    await new Promise((resolve) => gateway.close(resolve))
  })
  const send = async (body, userAgent) => {
    const response = await fetch(`http://127.0.0.1:${gateway.address().port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': userAgent },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    return captured.at(-1)
  }
  const switchPreset = (presetNow) => {
    routing = writeRouting(presetNow)
    fs.writeFileSync(configPath, JSON.stringify(kernelConfig(presetNow)))
  }
  return { send, switchPreset, logs, health: () => unixRequest(socketPath, token, '/internal/health') }
}

const ENV = [
  '# Environment',
  'You have been invoked in the following environment: ',
  ' - Primary working directory: /srv/app',
  ' - Is a git repository: true',
  ' - Platform: linux',
  ' - Shell: bash',
  ' - OS Version: Linux 6.6.1-test',
  OFFICIAL_303_ENV_UNTRUSTED,
  '',
  'You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5. Assistant knowledge cutoff is June 2026.',
].join('\n')
const AFTER_ENV =
  "\n\n# Language\nAlways respond in Chinese.\n\n<total_tokens>15000000 tokens left</total_tokens>\n\nToday's date is 2026-10-22."
const OFFICIAL_UA = 'claude-cli/2.1.303 (external, cli)'

function officialRequest(model = 'claude-opus-5-5', history = []) {
  return {
    model,
    max_tokens: 32000,
    stream: true,
    metadata: {
      user_id: JSON.stringify({
        device_id: 'ab'.repeat(32),
        account_uuid: '',
        session_id: '11111111-2222-4333-8444-555555555555',
      }),
    },
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303.abc; cc_entrypoint=cli; cch=00000;' },
      { type: 'text', text: OFFICIAL_303_IDENTITY, cache_control: { type: 'ephemeral' } },
      {
        type: 'text',
        text: OFFICIAL_303_MAIN_PROMPT.replace('{{memory_dir}}', '/home/caller/.claude/projects/-srv-app/memory/'),
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<system-reminder>\nCLAUDE.md: be brief.\n</system-reminder>\n' },
          { type: 'text', text: 'hello', ...(history.length ? {} : { cache_control: { type: 'ephemeral' } }) },
        ],
      },
      { role: 'system', content: `${ENV}${AFTER_ENV}` },
      ...history,
    ],
    tools: [{ name: 'Bash', description: 'run a command', input_schema: { type: 'object', properties: {} } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
  }
}

function billingOf(wire) {
  return wire.body.system.find((block) => block.text.startsWith('x-anthropic-billing-header:'))?.text || ''
}

function assertCch(wire) {
  const cch = /\bcch=([0-9a-f]{5});/.exec(billingOf(wire))?.[1]
  assert.ok(cch && cch !== '00000', 'CCH sealed')
  assert.equal(computeClaudeCodeCch(Buffer.from(projectClaudeCodeCchText(wire.raw), 'utf8')), cch)
  assert.equal(Buffer.byteLength(wire.raw), Number(wire.headers['content-length']))
}

test('official_303 lean on the real chain: skeleton, rules, version, CCH', { skip, timeout: 60000 }, async (t) => {
  const h = await harness(t)
  const wire = await h.send(officialRequest(), OFFICIAL_UA)
  assert.deepEqual(checkOfficial303Rules(wire.body), [])
  const blocking = diffShapes(SKELETON, outboundShape(wire.body)).filter((diff) => !isAllowedSkeletonDiff(diff))
  assert.deepEqual(blocking, [])
  assert.deepEqual(Object.keys(wire.body), [
    'model',
    'messages',
    'system',
    'tools',
    'metadata',
    'max_tokens',
    'thinking',
    'output_config',
    'stream',
  ])
  assert.equal(wire.body.kin_outbound_shape, undefined)
  assert.match(wire.headers['user-agent'], /^claude-cli\/2\.1\.303 /)
  assert.match(
    billingOf(wire),
    /^x-anthropic-billing-header: cc_version=2\.1\.303\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5}; cc_prompt_id=/,
  )
  assert.equal(wire.raw.includes('/home/caller/'), false)
  assert.equal(wire.body.messages[1].content.endsWith(AFTER_ENV), true)
  assert.deepEqual(
    wire.body.system.map((block) => block.cache_control),
    [undefined, { type: 'ephemeral' }, { type: 'ephemeral' }],
  )
  assertCch(wire)
  assert.deepEqual(h.logs.at(-1).outbound_profile, { cli_version: '2.1.303', shape: 'lean' })
})

test('official_303 lean: non-official caller and a second turn keep the cached prefix bytes', {
  skip,
  timeout: 60000,
}, async (t) => {
  const h = await harness(t, { cacheTtl: '1h' })
  const bot = {
    model: 'claude-opus-5-5',
    max_tokens: 1024,
    stream: true,
    system: [{ type: 'text', text: 'You are a helpful bot.' }],
    messages: [{ role: 'user', content: 'q1' }],
  }
  const first = await h.send(bot, 'my-bot/1.0')
  assert.deepEqual(checkOfficial303Rules(first.body), [])
  assert.equal(
    first.body.messages[0].content[0].text,
    '<system-reminder>\nYou are a helpful bot.\n</system-reminder>\n',
  )
  assert.deepEqual(first.body.system[1].cache_control, { type: 'ephemeral', ttl: '1h' })
  const second = await h.send(
    {
      ...bot,
      messages: [
        ...bot.messages,
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: 'q2' },
      ],
    },
    'my-bot/1.0',
  )
  assert.deepEqual(checkOfficial303Rules(second.body), [])
  const strip = (value) => JSON.stringify(value, (key, inner) => (key === 'cache_control' ? undefined : inner))
  // cache_read covers system + the first turn only if these bytes match on the wire.
  assert.equal(
    strip(second.body.system.map((b) => (b.text.startsWith('x-anthropic') ? null : b))),
    strip(first.body.system.map((b) => (b.text.startsWith('x-anthropic') ? null : b))),
  )
  // This harness has no sticky binding, so each attempt mints a new outbound session (cc_prompt_id).
  // Production reuses it on the same VM; the real-account two-turn check covers that.
  const stable = (wire) =>
    billingOf(wire)
      .replace(/cch=[0-9a-f]{5}/, '')
      .replace(/cc_prompt_id=[0-9a-f-]{36}/, '')
  assert.equal(stable(second), stable(first))
  assert.equal(strip(second.body.messages[0]), strip(first.body.messages[0]))
  assert.equal(strip(second.body.tools), strip(first.body.tools))
})

test('official_303 full-prompt model keeps the existing body at 2.1.303; hot switch back to 296', {
  skip,
  timeout: 60000,
}, async (t) => {
  const h = await harness(t)
  const sonnet = await h.send(officialRequest('claude-sonnet-5-5'), OFFICIAL_UA)
  assert.match(sonnet.headers['user-agent'], /^claude-cli\/2\.1\.303 /)
  assert.match(billingOf(sonnet), /cc_version=2\.1\.303\./)
  assert.equal(sonnet.body.system.length, 3)
  assert.equal(sonnet.body.kin_outbound_shape, undefined)
  const pidBefore = JSON.parse(await h.health()).pid ?? null
  h.switchPreset('official_full')
  const back = await h.send(officialRequest(), OFFICIAL_UA)
  assert.match(back.headers['user-agent'], /^claude-cli\/2\.1\.296 /)
  assert.match(billingOf(back), /cc_version=2\.1\.296\./)
  assert.equal(back.body.messages.at(-1).role, 'system')
  assert.equal(back.body.system[1].text, OFFICIAL_303_IDENTITY)
  assert.equal(JSON.parse(await h.health()).pid ?? null, pidBefore)
})

for (const caller of ['official', 'bot'])
  test(`296 presets: profile cli-node sends the same bytes as the baseline (${caller})`, {
    skip: skip || !baseCli || !fs.existsSync(baseCli),
    timeout: 90000,
  }, async (t) => {
    const request =
      caller === 'official'
        ? [officialRequest(), OFFICIAL_UA]
        : [
            {
              model: 'claude-opus-5-5',
              max_tokens: 1024,
              stream: true,
              system: [{ type: 'text', text: 'You are a helpful bot.' }],
              messages: [{ role: 'user', content: 'q1' }],
            },
            'my-bot/1.0',
          ]
    for (const preset of ['official', 'official_full', 'zero']) {
      const base = await (await harness(t, { preset, cli: baseCli })).send(...request)
      const next = await (await harness(t, { preset })).send(...request)
      const neutral = (wire) =>
        JSON.stringify({
          ...wire.body,
          metadata: null,
          // cc_prompt_id follows each attempt's outbound session; CCH follows the body.
          system: wire.body.system.map((block) => ({
            ...block,
            text: block.text
              .replace(/cch=[0-9a-f]{5}/, 'cch=X')
              .replace(/cc_prompt_id=[0-9a-f-]{36}/, 'cc_prompt_id=X'),
          })),
        })
      assert.equal(neutral(next), neutral(base), preset)
      assert.equal(next.headers['user-agent'], base.headers['user-agent'])
    }
  })
