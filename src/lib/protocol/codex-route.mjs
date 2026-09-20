/**
 * Codex hop routing. Claude traffic never reads this object.
 */
import { isCodexVm } from '../vm/vm-kind.mjs'
import { DEFAULT_CODEX_ROTATE, normalizeCodexRotate } from './codex-rotate.mjs'

export { isCodexVm, normalizeVmKind } from '../vm/vm-kind.mjs'
export { DEFAULT_CODEX_ROTATE, normalizeCodexRotate } from './codex-rotate.mjs'

export const CODEX_PROTOCOLS = Object.freeze(['openai.responses', 'openai.chat', 'openai.completions'])

export const DEFAULT_CODEX_ROUTING = Object.freeze({
  enabled: true,
  protocols: {
    'openai.responses': { mode: 'native', enabled: true },
    'openai.chat': { mode: 'convert', enabled: true },
    'openai.completions': { mode: 'convert', enabled: true },
    'anthropic.messages': { mode: 'reject', enabled: false },
  },
  convert: {
    chat_to_codex: true,
    completions_to_codex: true,
    anthropic_to_codex: false,
  },
  clients: {
    official_codex: 'allow',
    openai_compatible: 'allow',
    claude_code: 'reject',
    unknown: 'allow',
  },
  plugin: {
    rotate: { ...DEFAULT_CODEX_ROTATE },
  },
})

export function normalizeCodexRouting(raw = {}) {
  const protocols = { ...DEFAULT_CODEX_ROUTING.protocols, ...(raw.protocols || {}) }
  for (const key of Object.keys(protocols)) {
    const item = protocols[key] || {}
    const mode = ['native', 'convert', 'reject'].includes(item.mode) ? item.mode : 'reject'
    protocols[key] = { mode, enabled: item.enabled !== false && mode !== 'reject' }
  }
  const clients = { ...DEFAULT_CODEX_ROUTING.clients, ...(raw.clients || {}) }
  for (const [key, value] of Object.entries(clients)) {
    clients[key] = value === 'allow' ? 'allow' : 'reject'
  }
  return {
    enabled: raw.enabled !== false,
    protocols,
    convert: {
      chat_to_codex: raw.convert?.chat_to_codex !== false,
      completions_to_codex: raw.convert?.completions_to_codex !== false,
      anthropic_to_codex: raw.convert?.anthropic_to_codex === true,
    },
    clients,
    plugin: {
      rotate: normalizeCodexRotate(raw.plugin?.rotate),
    },
  }
}

export function isCodexProtocolAllowed(protocol, routing = {}) {
  const codex = normalizeCodexRouting(routing.codex || routing)
  if (!codex.enabled) return { ok: false, code: 'codex_disabled', mode: 'reject' }
  const entry = codex.protocols[protocol]
  if (!entry || entry.enabled === false || entry.mode === 'reject') {
    return { ok: false, code: 'protocol_not_allowed', mode: 'reject' }
  }
  return { ok: true, mode: entry.mode }
}

export function listCodexVms(vms = []) {
  return (vms || []).filter((vm) => isCodexVm(vm))
}
