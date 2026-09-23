import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isCodexProtocolAllowed,
  isCodexVm,
  listCodexVms,
  normalizeCodexRouting,
} from '../../src/lib/protocol/codex-route.mjs'

test('default routing allows responses and chat, rejects anthropic', () => {
  const routing = { codex: normalizeCodexRouting() }
  assert.equal(isCodexProtocolAllowed('openai.responses', routing).ok, true)
  assert.equal(isCodexProtocolAllowed('openai.chat', routing).mode, 'convert')
  assert.equal(isCodexProtocolAllowed('anthropic.messages', routing).ok, false)
  assert.equal(isCodexProtocolAllowed('anthropic.messages', routing).code, 'protocol_not_allowed')
})

test('disabled hop rejects every protocol', () => {
  const routing = { codex: normalizeCodexRouting({ enabled: false }) }
  assert.equal(isCodexProtocolAllowed('openai.responses', routing).code, 'codex_disabled')
})

test('retired rotate plugin is not revived from saved routing', () => {
  const routing = normalizeCodexRouting({
    plugin: { rotate: { enabled: true, inject_state: true, auto_collect: true } },
  })
  assert.equal(routing.plugin, undefined)
})

test('codex vm filter ignores Claude slots', () => {
  const vms = [
    { id: 'vm-claude', inference_engine: 'rust' },
    { id: 'vm-codex', platform: 'openai', family: 'codex' },
    { id: 'vm-codex-legacy', codex_kernel: true },
    { id: 'vm-codex-engine', inference_engine: 'codex' },
  ]
  assert.equal(isCodexVm(vms[0]), false)
  assert.deepEqual(
    listCodexVms(vms).map((v) => v.id),
    ['vm-codex', 'vm-codex-legacy', 'vm-codex-engine'],
  )
})
