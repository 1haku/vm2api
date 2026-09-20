import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { writeWorkerCredentialFile, readWorkerCredentialFile } from '../../src/lib/oauth/oauth-credentials.mjs'
import { hostCountTokens, hostOauthUsage, hostModels } from '../../src/lib/oauth/host-anthropic.mjs'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kin-host-anthropic-'))
}

test('host write seals credentials.json as 0444', () => {
  const home = tempHome()
  const file = writeWorkerCredentialFile(home, {
    type: 'setup-token',
    access_token: 'sk-ant-oat01-live',
    refresh_token: 'sk-ant-ort01-live',
    expires_at: Date.now() + 8 * 3600_000,
  })
  assert.equal(fs.statSync(file).mode & 0o777, 0o444)
  const again = writeWorkerCredentialFile(home, {
    type: 'setup-token',
    access_token: 'sk-ant-oat01-next',
    refresh_token: 'sk-ant-ort01-live',
    expires_at: Date.now() + 8 * 3600_000,
  })
  assert.equal(readWorkerCredentialFile(home).access_token, 'sk-ant-oat01-next')
  assert.equal(fs.statSync(again).mode & 0o777, 0o444)
  fs.rmSync(home, { recursive: true, force: true })
})

test('host count_tokens posts Anthropic path over SOCKS mock', async () => {
  const home = tempHome()
  writeWorkerCredentialFile(home, {
    type: 'setup-token',
    access_token: 'sk-ant-oat01-live',
    refresh_token: 'sk-ant-ort01-live',
    expires_at: Date.now() + 8 * 3600_000,
  })
  let seen = null
  const fetchImpl = async (url, opts) => {
    seen = { url, method: opts.method, headers: opts.headers, body: opts.body, agent: !!opts.agent }
    return {
      ok: true,
      status: 200,
      headers: { forEach: (fn) => fn('7', 'anthropic-ratelimit-requests-remaining') },
      text: async () => JSON.stringify({ input_tokens: 12 }),
    }
  }
  const hop = await hostCountTokens(
    { homeDir: home, vm: { proxy: { url: 'socks5h://127.0.0.1:1080' } } },
    {
      body: { model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
      fetchImpl,
    },
  )
  assert.equal(hop.ok, true)
  assert.equal(hop.body.input_tokens, 12)
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages/count_tokens')
  assert.equal(seen.method, 'POST')
  assert.equal(seen.headers.authorization, 'Bearer sk-ant-oat01-live')
  assert.equal(seen.agent, true)
  fs.rmSync(home, { recursive: true, force: true })
})

test('host usage refuses apikey and models requires SOCKS', async () => {
  const home = tempHome()
  writeWorkerCredentialFile(home, { type: 'apikey', api_key: 'sk-ant-api03-xxxxxxxx' })
  const usage = await hostOauthUsage({ homeDir: home, vm: { proxy: { url: 'socks5h://127.0.0.1:1080' } } })
  assert.equal(usage.ok, false)
  assert.equal(usage.body.error.code, 'usage_unsupported')
  const models = await hostModels({ homeDir: home, vm: { id: 'vm-05' } })
  assert.equal(models.ok, false)
  assert.equal(models.body.error.code, 'proxy_required')
  fs.rmSync(home, { recursive: true, force: true })
})

test('host models on local egress hops without SOCKS agent', async () => {
  const home = tempHome()
  writeWorkerCredentialFile(home, {
    type: 'setup-token',
    access_token: 'sk-ant-oat01-live',
    scopes: ['user:inference'],
  })
  let seen = null
  const fetchImpl = async (url, opts) => {
    seen = { url, agent: opts.agent }
    return {
      ok: true,
      status: 200,
      headers: { forEach: () => {} },
      text: async () => JSON.stringify({ data: [] }),
    }
  }
  const hop = await hostModels(
    {
      homeDir: home,
      vm: { id: 'vm-01', proxy: { id: 'px-local', host: 'local', port: 0, scheme: 'local' } },
    },
    { fetchImpl },
  )
  assert.equal(hop.ok, true)
  assert.equal(seen.agent, undefined)
  fs.rmSync(home, { recursive: true, force: true })
})
