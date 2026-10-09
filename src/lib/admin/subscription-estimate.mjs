/** Admission estimate only. Never use this approximation to settle actual usage.
 * Text uses a conservative UTF-8 / 3 heuristic with 25% headroom; transport
 * metadata, image encodings and opaque reasoning are not text tokens.
 * Unknown media/context receive explicit allowances, not a claimed exact count.
 * No cache discount is assumed before the upstream reports a cache hit.
 */
export function estimateSubscriptionInput(body = {}) {
  let textBytes = 0
  let overhead = 0
  let media = 0
  let opaque = 0
  const text = (value) => {
    if (value != null) textBytes += Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value))
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
      if (value.encrypted_content) opaque += 8192
      visit(value.summary, depth + 1)
      visit(value.content, depth + 1)
      return
    }
    if (type === 'redacted_thinking') {
      opaque += 8192
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
  const tokens = Math.ceil((textBytes / 3 + overhead) * 1.25) + media + opaque + 8192
  return { tokens, text_bytes: textBytes, media_tokens: media, opaque_tokens: opaque }
}
