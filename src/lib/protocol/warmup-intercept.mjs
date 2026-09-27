/**
 * Claude Code warmup / title / suggestion / haiku-ping requests (sub2api
 * detectInterceptType). Answered locally before any account is selected, so
 * they never take a seat, a sticky pin, quota, or an upstream call.
 */
import crypto from 'node:crypto'

const TITLE_PROMPT = 'Please write a 5-10 word title for the following conversation:'
// Real CLI text starts with "Analyze"; sub2api matches without the first letter.
const TOPIC_SYSTEM = 'nalyze if this message indicates a new conversation topic. If it does, extract a 2-3 word title'
const SUGGESTION_PREFIX = '[SUGGESTION MODE:'

const MOCKS = Object.freeze({
  haiku_ping: { chunks: ['#'], stop_reason: 'max_tokens', output_tokens: 1 },
  suggestion: { chunks: [''], stop_reason: 'end_turn', output_tokens: 1 },
  warmup: { chunks: ['New', ' Conversation'], stop_reason: 'end_turn', output_tokens: 2 },
})

function textsOf(content) {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content
    .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text : null))
    .filter((text) => typeof text === 'string')
}

function systemTextOf(system) {
  if (typeof system === 'string') return system
  return textsOf(system).join('\n')
}

/** @returns {null | 'haiku_ping' | 'suggestion' | 'warmup'} */
export function detectWarmupIntercept(body = {}) {
  if (!body || typeof body !== 'object') return null
  const model = String(body.model || '').toLowerCase()
  if (Number(body.max_tokens) === 1 && model.includes('haiku')) return 'haiku_ping'
  const messages = Array.isArray(body.messages) ? body.messages : []
  const lastUser = [...messages].reverse().find((m) => String(m?.role || '').toLowerCase() === 'user')
  const lastFirst = lastUser ? textsOf(lastUser.content)[0] : null
  if (typeof lastFirst === 'string' && lastFirst.startsWith(SUGGESTION_PREFIX)) return 'suggestion'
  for (const msg of messages) {
    for (const text of textsOf(msg?.content)) {
      if (text === 'Warmup' || text.includes(TITLE_PROMPT)) return 'warmup'
    }
  }
  if (systemTextOf(body.system).includes(TOPIC_SYSTEM)) return 'warmup'
  return null
}

function messageId() {
  return `msg_01${crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, 22)}`
}

function usage(outputTokens) {
  return {
    input_tokens: 10,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: outputTokens,
  }
}

export function warmupMockMessage(kind, model) {
  const mock = MOCKS[kind] || MOCKS.warmup
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model: String(model || ''),
    content: [{ type: 'text', text: mock.chunks.join('') }],
    stop_reason: mock.stop_reason,
    stop_sequence: null,
    usage: usage(mock.output_tokens),
  }
}

/** Full Anthropic SSE through message_stop. Haiku ping keeps "#" / max_tokens like the JSON form. */
export function formatWarmupSse(kind, model) {
  const mock = MOCKS[kind] || MOCKS.warmup
  const lines = []
  const ev = (event, data) => lines.push(`event: ${event}`, `data: ${JSON.stringify(data)}`, '')
  ev('message_start', {
    type: 'message_start',
    message: {
      id: messageId(),
      type: 'message',
      role: 'assistant',
      model: String(model || ''),
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usage(0),
    },
  })
  ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  for (const text of mock.chunks) {
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  }
  ev('content_block_stop', { type: 'content_block_stop', index: 0 })
  ev('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mock.stop_reason, stop_sequence: null },
    usage: { output_tokens: mock.output_tokens },
  })
  ev('message_stop', { type: 'message_stop' })
  return `${lines.join('\n')}\n`
}
