import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { ApiScheduler } from '../../src/lib/pool/api-scheduler.mjs'
import {
  anthropicConsoleResult,
  anthropicMessagesUrl,
  buildAnthropicConsoleRequest,
} from '../../src/lib/admin/anthropic-console.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { authorizePanelRoute, canViewPage } from '../../src/lib/admin/panel-acl.mjs'
import { readBody } from '../../src/lib/http/respond.mjs'

const endpoint = {
  id: 'ep_1',
  name: 'third',
  disabled: false,
  prefix: 'relay',
  priority: 5,
  base_url: 'https://relay.example/v1/',
  kind: 'custom',
  protocol: 'anthropic',
  auth_scheme: 'authorization_bearer',
  headers: { 'anthropic-beta': 'messages-2023-12-15' },
  models: [{ name: 'claude-upstream', alias: 'sonnet' }],
  api_key_entries: [{ id: 'key_1', api_key: 'sk-upstream-secret', proxy_url: 'socks5://10.0.0.8:1080', disabled: false }],
}

test('direct console defaults to official x-api-key and keeps the key out of metadata', () => {
  const request = buildAnthropicConsoleRequest({
    api_key: 'sk-ant-direct',
    model: 'claude-sonnet-4-5',
    message: 'Hi',
  })
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages?beta=true')
  assert.equal(request.headers['x-api-key'], 'sk-ant-direct')
  assert.equal(request.headers.authorization, undefined)
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  assert.equal(request.proxyUrl, '')
  assert.equal(request.body.model, 'claude-sonnet-4-5')
  assert.deepEqual(request.meta, {
    mode: 'direct',
    auth_scheme: 'x_api_key',
    endpoint_id: null,
    endpoint_name: null,
    key_id: null,
    requested_model: 'claude-sonnet-4-5',
    upstream_model: 'claude-sonnet-4-5',
    proxy: false,
  })
  assert.equal(JSON.stringify(request.meta).includes('sk-ant-direct'), false)
})

test('direct console accepts a third-party url, bearer auth, and a proxy', () => {
  const request = buildAnthropicConsoleRequest({
    base_url: 'https://relay.example/v1/',
    api_key: 'sk-third',
    auth_scheme: 'authorization_bearer',
    proxy_url: 'http://user:pass@127.0.0.1:8080',
    model: 'alias',
    max_tokens: 32,
    message: 'ping',
    headers: { 'x-account': 'a' },
  })
  assert.equal(request.url, 'https://relay.example/v1/messages?beta=true')
  assert.equal(request.headers.authorization, 'Bearer sk-third')
  assert.equal(request.headers['x-api-key'], undefined)
  assert.equal(request.headers['x-account'], 'a')
  assert.equal(request.proxyUrl, 'http://user:pass@127.0.0.1:8080')
  assert.equal(request.body.max_tokens, 32)
})

test('scheduled console uses the API picker, upstream model, auth, and key proxy', () => {
  const scheduler = new ApiScheduler()
  scheduler.reload([endpoint])
  const picked = scheduler.pick('relay/sonnet')
  const request = buildAnthropicConsoleRequest({ mode: 'scheduled', model: 'relay/sonnet', message: 'Hi' }, picked)
  assert.equal(request.url, 'https://relay.example/v1/messages?beta=true')
  assert.equal(request.body.model, 'claude-upstream')
  assert.equal(request.headers.authorization, 'Bearer sk-upstream-secret')
  assert.equal(request.headers['anthropic-beta'], 'messages-2023-12-15')
  assert.equal(request.proxyUrl, 'socks5://10.0.0.8:1080')
  assert.equal(request.meta.endpoint_id, 'ep_1')
  assert.equal(request.meta.key_id, 'key_1')
  assert.equal(request.meta.proxy, true)
  assert.equal(JSON.stringify(request.meta).includes('sk-upstream-secret'), false)
})

test('scheduled console fails before dialing when no endpoint serves the model', () => {
  assert.throws(
    () => buildAnthropicConsoleRequest({ mode: 'scheduled', model: 'missing', message: 'Hi' }, {
      ok: false,
      code: 'model_not_found',
      message: 'no api endpoint serves missing',
    }),
    (error) => error.code === 'model_not_found' && error.status === 404,
  )
})

test('proxy schemes outside the kernel client are rejected', () => {
  assert.throws(
    () => buildAnthropicConsoleRequest({
      api_key: 'sk-ant',
      model: 'm',
      message: 'Hi',
      proxy_url: 'ftp://127.0.0.1:21',
    }),
    (error) => error.code === 'invalid_proxy_url',
  )
  assert.equal(anthropicMessagesUrl('http://plain.example'), 'http://plain.example/v1/messages?beta=true')
})

test('upstream text is extracted and error bodies stay on the panel result', async () => {
  const ok = await anthropicConsoleResult(
    { statusCode: 200, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({
      content: [{ type: 'text', text: 'pong' }],
    })) } },
    { mode: 'direct', proxy: false },
  )
  assert.equal(ok.ok, true)
  assert.equal(ok.text, 'pong')

  const failed = await anthropicConsoleResult(
    { statusCode: 401, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({
      error: { message: 'bad key' },
    })) } },
    { mode: 'direct' },
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.error, 'bad key')
})
function unwrapPanel(payload) {
  if (!payload || payload.ok === false) {
    const error = new Error(payload?.error?.message || '请求失败')
    error.panel = false
    throw error
  }
  return payload.data !== undefined ? payload.data : payload
}

test('panel keeps upstream 401 and 429 inside data so the page can render them', async () => {
  const cases = [
    { statusCode: 401, message: 'bad key' },
    { statusCode: 429, message: 'slow down' },
  ]
  for (const item of cases) {
    let forwarded = null
    const response = {}
    const handlePanel = createPanelHandler({
      cfg: { paths: { project: '/tmp/anthropic-console-test' } },
      readBody,
      forwardApi: async (request) => {
        forwarded = request
        return {
          statusCode: item.statusCode,
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(JSON.stringify({ error: { message: item.message } }))
          },
        }
      },
      requireAuth(req) {
        req.panelUser = 'admin'
        req.panelRole = 'admin'
        return true
      },
      json(_res, status, body) {
        response.status = status
        response.body = body
      },
    })
    const req = Readable.from([Buffer.from(JSON.stringify({
      api_key: 'sk-ant-live',
      model: 'claude-sonnet-4-5',
      message: 'Hi',
    }))])
    req.method = 'POST'
    await handlePanel(req, {}, new URL('http://localhost/api/panel/anthropic/messages'))
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    const shown = unwrapPanel(response.body)
    assert.equal(shown.ok, false)
    assert.equal(shown.status, item.statusCode)
    assert.equal(shown.error, item.message)
    assert.equal(JSON.stringify(response.body).includes('sk-ant-live'), false)
    assert.equal(forwarded.headers['x-api-key'], 'sk-ant-live')
  }
})

test('anthropic console is admin-only', () => {
  assert.equal(canViewPage('admin', 'anthropic'), true)
  assert.equal(canViewPage('user', 'anthropic'), false)
  assert.equal(canViewPage('super', 'anthropic'), false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/anthropic/messages', 'user').ok, false)
  assert.equal(authorizePanelRoute('POST', '/api/panel/anthropic/messages', 'admin').ok, true)
})
