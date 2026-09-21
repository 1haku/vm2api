import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'

function tmpDir(prefix = 'kin-sticky-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('bind + resolve + hits increment', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-1', { accountId: 'acc-1', vmId: 'vm-1', sessionId: 'sess-9' })
  const hit = r.resolve('conv-1')
  assert.equal(hit.accountId, 'acc-1')
  assert.equal(hit.vmId, 'vm-1')
  assert.equal(hit.sessionId, 'sess-9')
  r.bind('conv-1', { accountId: 'acc-1', vmId: 'vm-1' })
  assert.equal(r.stats().sessions['conv-1'].hits, 2)
  // session_id preserved from previous bind
  assert.equal(r.stats().sessions['conv-1'].session_id, 'sess-9')
})

test('expired sessions purge on resolve/stats', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: -1 } } })
  r.bind('conv-2', { accountId: 'a', vmId: 'v' })
  assert.equal(r.resolve('conv-2'), null)
  assert.equal(r.stats().active_sessions, 0)
})

test('disabled sticky returns null and binds nothing', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: false } } })
  r.bind('conv-3', { accountId: 'a', vmId: 'v' })
  assert.equal(r.resolve('conv-3'), null)
})

test('sticky sessions persist across re-open', () => {
  const dir = tmpDir()
  const cfg = { sticky: { enabled: true, ttl_seconds: 3600 } }
  const r1 = new StickyRouter({ dataDir: dir, config: cfg })
  r1.bind('conv-4', { accountId: 'acc-4', vmId: 'vm-4' })

  const r2 = new StickyRouter({ dataDir: dir, config: cfg })
  const hit = r2.resolve('conv-4')
  assert.ok(hit)
  assert.equal(hit.accountId, 'acc-4')
})

test('extractKey uses default header_keys when config omits them', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'conversation' } } })
  const key = r.extractKey({ headers: { 'x-session-id': 'sess-default' } }, {})
  assert.equal(key, 'sess-default')
})

test('extractKey prefers metadata.user_id session over headers', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const key = r.extractKey(
    { headers: { 'x-session-id': 'header-sess' } },
    { metadata: { user_id: { session_id: 'meta-sess' } } },
  )
  assert.equal(key, 'meta-sess')
})

test('persistable envelope from one API key shares one sticky key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'conversation' } } })
  const a = r.extractKey(
    { apiKeyRecord: { id: 'key_f041' }, headers: { 'thread-id': '01a0b947-aaaa' } },
    {
      thread_id: '01a0b947-aaaa',
      metadata: { user_id: { session_id: 'sess-aaaa' } },
      messages: [
        {
          role: 'user',
          content: 'thread_id: 01a0b947-aaaa\n\nPersistable response items (JSON):\n[{"text":"缓存修复"}]',
        },
      ],
    },
  )
  const b = r.extractPoolKey(
    { apiKeyRecord: { id: 'key_f041' }, headers: { 'thread-id': '01a0bab2-bbbb' } },
    {
      thread_id: '01a0bab2-bbbb',
      metadata: { user_id: { session_id: 'sess-bbbb' } },
      messages: [
        {
          role: 'user',
          content: 'thread_id: 01a0bab2-bbbb\n\nPersistable response items (JSON):\n[{"text":"套餐识别"}]',
        },
      ],
    },
  )
  assert.equal(a, 'kkey_f041:envelope')
  assert.equal(a, b)
})

test('persistable envelope beats a per-hop device_id in extractPoolKey', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'conversation' } } })
  const a = r.extractPoolKey(
    { apiKeyRecord: { id: 'key_f041' } },
    {
      metadata: { user_id: { device_id: 'dev-aaaa', session_id: 'sess-aaaa' } },
      messages: [{ role: 'user', content: 'Persistable response items (JSON):\n[{"text":"缓存修复"}]' }],
    },
  )
  const b = r.extractPoolKey(
    { apiKeyRecord: { id: 'key_f041' } },
    {
      metadata: { user_id: { device_id: 'dev-bbbb', session_id: 'sess-bbbb' } },
      messages: [{ role: 'user', content: 'Persistable response items (JSON):\n[{"text":"套餐识别"}]' }],
    },
  )
  assert.equal(a, 'kkey_f041:envelope')
  assert.equal(a, b)
})

test('persistable envelope keys stay isolated per API key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'conversation' } } })
  const body = {
    messages: [{ role: 'user', content: 'Persistable response items (JSON):\n[{"text":"任务"}]' }],
  }
  assert.equal(r.extractKey({ apiKeyRecord: { id: 'key_a' } }, body), 'kkey_a:envelope')
  assert.equal(r.extractKey({ apiKeyRecord: { id: 'key_b' } }, body), 'kkey_b:envelope')
})

test('ip mode does not switch envelope traffic onto the API-key envelope key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'ip' } } })
  const key = r.extractKey(
    { apiKeyRecord: { id: 'key_f041' }, headers: { 'x-forwarded-for': '203.0.113.9' } },
    { messages: [{ role: 'user', content: 'Persistable response items (JSON):\n[{"text":"任务"}]' }] },
  )
  assert.equal(key, 'kkey_f041:ip:203.0.113.9')
})

test('plain first-user hash is unchanged without envelope', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const a = r.extractKey(
    { apiKeyRecord: { id: 'key_f041' } },
    { messages: [{ role: 'user', content: '同一段会话的第一句' }] },
  )
  const b = r.extractKey({ apiKeyRecord: { id: 'key_f041' } }, { messages: [{ role: 'user', content: '另一段会话' }] })
  assert.match(a, /^kkey_f041:ch:/)
  assert.notEqual(a, b)
})

test('extractKey ignores x-client-request-id and hashes first user', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const a = r.extractKey(
    { headers: { 'x-client-request-id': 'req-aaaa' } },
    { messages: [{ role: 'user', content: '同一段会话的第一句' }] },
  )
  const b = r.extractKey(
    { headers: { 'x-client-request-id': 'req-bbbb' } },
    {
      messages: [
        { role: 'user', content: '同一段会话的第一句' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: '第二句' },
      ],
    },
  )
  assert.ok(a && a.startsWith('ch:'))
  assert.equal(a, b)
})

test('extractKey mode=ip uses forwarded address', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'ip' } } })
  const key = r.extractKey({ headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }, {})
  assert.equal(key, 'ip:203.0.113.9')
})

test('extractKey mode=session isolates by API key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, mode: 'session' } } })
  assert.equal(r.extractKey({ apiKeyRecord: { id: 4 } }, {}), 'k4:login')
})

test('extractOfficialFamilyKey binds parent and child hops by device_id', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const parent = r.extractOfficialFamilyKey(
    { headers: { 'x-claude-code-session-id': 'parent-sess' } },
    { metadata: { user_id: { device_id: 'aabbcc', session_id: 'parent-sess' } } },
  )
  const child = r.extractOfficialFamilyKey(
    { headers: { 'x-claude-code-session-id': 'child-sess' } },
    { metadata: { user_id: { device_id: 'aabbcc', session_id: 'child-sess' } } },
  )
  assert.equal(parent, 'dev:aabbcc')
  assert.equal(child, parent)
  assert.notEqual(
    r.extractKey(
      { headers: { 'x-claude-code-session-id': 'child-sess' } },
      { metadata: { user_id: { device_id: 'aabbcc', session_id: 'child-sess' } } },
    ),
    parent,
  )
})

test('parent and child hops share one sticky session', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const parentReq = {
    headers: { 'user-agent': 'claude-cli/2.1.241 (external, sdk-cli)', 'x-claude-code-session-id': 'parent-sess' },
  }
  const parentBody = { metadata: { user_id: { device_id: 'aabbcc', session_id: 'parent-sess' } } }
  const childReq = {
    headers: {
      'user-agent': 'claude-cli/2.1.241 (external, local-agent, agent-sdk/0.3.241)',
      'x-claude-code-session-id': 'child-sess',
    },
  }
  const childBody = { metadata: { user_id: { device_id: 'aabbcc', session_id: 'child-sess' } } }
  assert.equal(r.extractPoolKey(parentReq, parentBody), 'dev:aabbcc')
  assert.equal(r.extractPoolKey(childReq, childBody), 'dev:aabbcc')
  r.bind('child-sess', { accountId: 'acc-2', vmId: 'vm-02' })
  r.bind('dev:aabbcc', { accountId: 'acc-1', vmId: 'vm-01' })
  assert.equal(r.extractPoolKey(childReq, childBody), 'dev:aabbcc')
  assert.deepEqual(r.collectPoolKeys(childReq, childBody), ['dev:aabbcc', 'child-sess'])
  assert.equal(r.resolve(r.extractPoolKey(childReq, childBody)).vmId, 'vm-01')
})

test('anthropic and openai sticky keys do not share a session', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const req = { headers: { 'x-session-id': 'same-session' } }
  const body = { metadata: { user_id: { session_id: 'same-session' } } }
  const claude = r.extractPoolKey(req, body, { platform: 'anthropic' })
  const gpt = r.extractPoolKey(req, body, { platform: 'openai' })
  assert.equal(claude, 'p:anthropic:same-session')
  assert.equal(gpt, 'p:openai:same-session')
  r.bind(claude, { accountId: 'acc-claude', vmId: 'vm-claude' })
  assert.equal(r.resolve(gpt), null)
  assert.equal(r.extractPoolKey(req, body, { platform: 'openai' }), gpt)
  assert.equal(r.resolve(r.extractPoolKey(req, body, { platform: 'anthropic' })).vmId, 'vm-claude')
})

test('protocol aliases resolve one conversation to the same account', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const firstUser = [{ role: 'user', content: '同一段跨协议会话的首条消息' }]
  const anthropic = {
    metadata: { user_id: { session_id: 'anthropic-session' } },
    messages: firstUser,
  }
  const openai = { messages: firstUser }
  const req = { apiKeyRecord: { id: 'key_cross_protocol' }, headers: {} }

  const primary = r.extractPoolKey(req, anthropic)
  const aliases = r.collectPoolKeys(req, anthropic)
  assert.equal(primary, 'kkey_cross_protocol:anthropic-session')
  assert.match(aliases[1], /^kkey_cross_protocol:ch:/)
  for (const key of aliases) r.bind(key, { accountId: 'acc-1', vmId: 'vm-01' })

  assert.equal(r.resolve(r.extractPoolKey(req, openai)).vmId, 'vm-01')
})

test('explicit session is the stable lock when concurrent turns have different first messages', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const req = { apiKeyRecord: { id: 'key_lock' }, headers: { 'x-session-id': 'shared-session' } }
  const first = { messages: [{ role: 'user', content: 'first visible turn' }] }
  const second = { messages: [{ role: 'user', content: 'trimmed current turn' }] }
  assert.equal(r.extractPoolKey(req, first), 'kkey_lock:shared-session')
  assert.equal(r.extractPoolKey(req, second), 'kkey_lock:shared-session')
  assert.notEqual(r.collectPoolKeys(req, first)[1], r.collectPoolKeys(req, second)[1])
})

test('provisional bind does not increment hits', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-p', { accountId: 'acc', vmId: 'vm-1' }, { countHit: false })
  assert.equal(r.stats().sessions['conv-p'].hits, 0)
  r.bind('conv-p', { accountId: 'acc', vmId: 'vm-1' })
  assert.equal(r.stats().sessions['conv-p'].hits, 1)
})

test('extractKey isolates the same session per API key', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true } } })
  const raw = { headers: { 'x-session-id': 'same-session' } }
  assert.equal(r.extractKey(raw, {}), 'same-session')
  assert.equal(r.extractKey({ ...raw, apiKeyRecord: { id: 7 } }, {}), 'k7:same-session')
})

test('unbind and unbindByAccount drop dead bindings', () => {
  const r = new StickyRouter({ dataDir: tmpDir(), config: { sticky: { enabled: true, ttl_seconds: 60 } } })
  r.bind('conv-dead', { accountId: 'acc-x', vmId: 'vm-02' })
  r.bind('conv-other', { accountId: 'acc-y', vmId: 'vm-04' })
  r.unbind('conv-dead')
  assert.equal(r.resolve('conv-dead'), null)
  r.bind('conv-dead', { accountId: 'acc-x', vmId: 'vm-02' })
  r.unbindByAccount({ vmId: 'vm-02' })
  assert.equal(r.resolve('conv-dead'), null)
  assert.equal(r.resolve('conv-other').vmId, 'vm-04')
})

test('proxy pool import/bind/config persist across re-open', () => {
  const dir = tmpDir('kin-proxy-')
  const pool = new ProxyPool({ dataDir: dir })
  const res = pool.importLines('socks5://user:pass@10.0.0.1:1080\n10.0.0.2:1080\nbadline:xx\n10.0.0.1:1080:user:pass')
  assert.equal(res.added, 2)
  const id = pool.snapshot().proxies[0].id
  assert.equal(pool.bind(id, 'vm-1').ok, true)
  pool.updateConfig({ probe_interval_min: 30, max_failures: 3 })
  pool.stopScheduler()

  const pool2 = new ProxyPool({ dataDir: dir })
  const snap = pool2.snapshot()
  assert.equal(snap.totals.total, 2)
  assert.equal(snap.config.probe_interval_min, 30)
  assert.equal(snap.config.max_failures, 3)
  assert.equal(snap.proxies.find((p) => p.id === id).bound_vm_id, 'vm-1')
  const forVm = pool2.getProxyForVm('vm-1')
  assert.equal(forVm.url, 'socks5://user:pass@10.0.0.1:1080')
  pool2.stopScheduler()
})

test('proxy remove + unbindVm persist', () => {
  const dir = tmpDir('kin-proxy-')
  const pool = new ProxyPool({ dataDir: dir })
  pool.importLines('10.1.1.1:1080\n10.1.1.2:1080')
  const [a, b] = pool.snapshot().proxies.map((p) => p.id)
  pool.bind(a, 'vm-z')
  pool.unbindVm('vm-z')
  pool.remove(b)
  pool.stopScheduler()

  const pool2 = new ProxyPool({ dataDir: dir })
  const snap = pool2.snapshot()
  assert.equal(snap.totals.total, 1)
  assert.equal(snap.proxies[0].bound_vm_id, null)
  pool2.stopScheduler()
})

test('disconnect_on_error config persists and runtime failure disables slot', () => {
  const dir = tmpDir('kin-proxy-')
  const disabled = []
  const disconnected = []
  const pool = new ProxyPool({
    dataDir: dir,
    onDisableVm: (vmId, reason, proxyId) => disabled.push({ vmId, reason, proxyId }),
    onDisconnectVm: (vmId, reason, proxyId) => disconnected.push({ vmId, reason, proxyId }),
  })
  pool.importLines('10.2.2.2:1080')
  const id = pool.snapshot().proxies[0].id
  pool.bind(id, 'vm-err')
  assert.equal(pool.snapshot().config.disconnect_on_error, false)
  const skipped = pool.reportRuntimeFailure('vm-err', 'proxy_transport_failure')
  assert.equal(skipped.skipped, true)
  assert.equal(disconnected.length, 0)

  const updated = pool.updateConfig({ disconnect_on_error: true, max_failures: 1 })
  assert.equal(updated.ok, true)
  assert.equal(updated.config.disconnect_on_error, true)
  pool.stopScheduler()

  const pool2 = new ProxyPool({
    dataDir: dir,
    onDisableVm: (vmId, reason, proxyId) => disabled.push({ vmId, reason, proxyId }),
    onDisconnectVm: (vmId, reason, proxyId) => disconnected.push({ vmId, reason, proxyId }),
  })
  assert.equal(pool2.snapshot().config.disconnect_on_error, true)
  const reported = pool2.reportRuntimeFailure('vm-err', 'proxy_transport_failure')
  assert.equal(reported.ok, true)
  assert.equal(reported.skipped, false)
  assert.equal(reported.proxy.status, 'dead')
  assert.equal(disconnected.length, 1)
  assert.equal(disconnected[0].vmId, 'vm-err')
  assert.match(disconnected[0].reason, /proxy_disconnect/)
  assert.equal(disabled.length, 0, 'runtime disconnect should not also fire probe disable')
  pool2.stopScheduler()
})
