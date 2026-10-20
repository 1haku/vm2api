/** Admission estimate only. Never use this approximation to settle actual usage.
 * OpenAI text uses local BPE with headroom; other text retains UTF-8 / 3.
 * Transport
 * metadata, image encodings and opaque reasoning are not text tokens.
 * Unknown media/context receive explicit allowances, not a claimed exact count.
 * No cache discount is assumed before the upstream reports a cache hit.
 */
import { modelsDevMeta, resolvePrice } from './price-catalog.mjs'
import { encryptedReasoningAllowance, subscriptionTextCounter } from './subscription-token-count.mjs'

function isOutputContentBlock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  switch (value.type) {
    case 'input_text':
    case 'text':
      return typeof value.text === 'string'
    case 'input_image':
      return typeof value.image_url === 'string' || typeof value.file_id === 'string'
    case 'image_url':
      return typeof value.image_url?.url === 'string'
    case 'image':
      return ['base64', 'url'].includes(value.source?.type)
    case 'input_file':
      return (
        typeof value.file_data === 'string' || typeof value.file_id === 'string' || typeof value.file_url === 'string'
      )
    default:
      return false
  }
}

export function estimateSubscriptionInput(body = {}) {
  const price = resolvePrice(body.model)
  const openAI = price?.platform === 'openai'
  const counter = subscriptionTextCounter(openAI)
  let textBytes = 0
  let overhead = 0
  let media = 0
  let opaque = 0
  let reasoningItems = 0
  let reasoningChars = 0
  const text = (value) => {
    if (value == null) return
    const content = typeof value === 'string' ? value : JSON.stringify(value)
    textBytes += Buffer.byteLength(content)
    counter.add(content)
  }
  const visit = (value, depth = 0) => {
    if (value == null) return
    // Avoid recursion failure on an invalid excessively nested request.
    if (depth > 64) {
      text(value)
      return
    }
    if (typeof value !== 'object') {
      text(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    overhead += 8
    const type = value.type
    if (['image', 'input_image', 'image_url'].includes(type)) {
      media += 8192
      return
    }
    if (['input_audio', 'audio'].includes(type)) {
      media += 16384
      return
    }
    if (['input_file', 'file', 'document'].includes(type)) {
      if (value.source?.type === 'text') text(value.source.data)
      else if (value.source?.type === 'content') visit(value.source.content, depth + 1)
      else media += 32768
      text(value.title)
      text(value.context)
      return
    }
    if (type === 'reasoning') {
      reasoningItems++
      if (typeof value.encrypted_content === 'string') reasoningChars += value.encrypted_content.length
      if (value.encrypted_content) opaque += openAI ? encryptedReasoningAllowance(value.encrypted_content) : 8192
      visit(value.summary, depth + 1)
      visit(value.content, depth + 1)
      return
    }
    if (type === 'redacted_thinking') {
      opaque += 8192
      return
    }
    if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      // Responses tool outputs may be multimodal content blocks. Serializing
      // that array would count image/file encodings as millions of text tokens.
      const output = value.output
      if (Array.isArray(output) && output.every(isOutputContentBlock)) visit(output, depth + 1)
      else text(output)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (['id', 'call_id', 'tool_call_id', 'type', 'role', 'status', 'signature', 'cache_control'].includes(key))
        continue
      // Tool arguments/results can contain arbitrary keys; all are prompt data.
      if (['arguments', 'input', 'output'].includes(key) && typeof item === 'object') text(item)
      else visit(item, depth + 1)
    }
  }
  for (const key of ['system', 'instructions', 'messages', 'input', 'prompt']) visit(body[key])
  for (const key of ['tools', 'functions', 'response_format']) text(body[key])
  text(body.text?.format)
  if (body.previous_response_id) opaque += 32768
  const counted = counter.result()
  const tokens = Math.ceil(counted.tokens + overhead * 1.25) + media + opaque + 8192
  return {
    tokens,
    text_bytes: textBytes,
    media_tokens: media,
    opaque_tokens: opaque,
    text_tokens: counted.text_tokens,
    fallback_bytes: counted.fallback_bytes,
    method: counted.method,
    reasoning_items: reasoningItems,
    reasoning_encoded_chars: reasoningChars,
  }
}

/** Bound only the admission estimate, never the request or settled usage.
 * Use published catalog metadata, not the caller's claimed token/context limit.
 * No known context metadata means no cap; unknown pricing still fails closed.
 * Keep the whole context allowance (without subtracting output) to avoid
 * assuming provider-specific input/output accounting. Output reserves separately.
 */
export function estimateSubscriptionReservationInput(body = {}) {
  const raw = estimateSubscriptionInput(body)
  const price = resolvePrice(body.model)
  const context = price ? Number(modelsDevMeta(price.platform, price.id)?.context) : NaN
  const contextLimit = Number.isSafeInteger(context) && context > 0 ? context : null
  const tokens = contextLimit == null ? raw.tokens : Math.min(raw.tokens, contextLimit)
  return {
    ...raw,
    tokens,
    raw_tokens: raw.tokens,
    context_limit: contextLimit,
    capped: tokens < raw.tokens,
  }
}
