/**
 * OpenAI-model hops always use Responses, matching codex-proxy-rs
 * (no upstream /v1/chat/completions). Inbound chat/messages stay
 * client-facing; only the hop + request log are washed.
 */

export const WASHED_OPENAI_PROTOCOL = 'openai.responses'
export const WASHED_OPENAI_PATH = '/v1/responses'

export function washedOpenaiHopMeta({ inboundPath = null, inboundProtocol = null, converted = true } = {}) {
  return {
    inbound_path: inboundPath || null,
    inbound_protocol: inboundProtocol || null,
    washed_path: WASHED_OPENAI_PATH,
    washed_protocol: WASHED_OPENAI_PROTOCOL,
    convert: !!converted,
  }
}

export function summarizeWashedResponses(body) {
  if (!body || typeof body !== 'object') return { empty: true }
  const keys = Object.keys(body)
    .filter((k) => k !== 'turn_state' && k !== 'client_metadata')
    .sort()
  return {
    model: body.model || null,
    stream: body.stream !== false,
    input_count: Array.isArray(body.input) ? body.input.length : body.input != null ? 1 : 0,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    top_level_keys: keys,
  }
}

export function publicWashedResponsesBody(body) {
  if (!body || typeof body !== 'object') return body
  const next = { ...body }
  delete next.turn_state
  if (next.client_metadata && typeof next.client_metadata === 'object') {
    const metadata = { ...next.client_metadata }
    delete metadata['x-codex-turn-state']
    next.client_metadata = metadata
  }
  return next
}

export function applyOpenaiWashLog(logBag, { inboundPath, inboundProtocol, converted, outboundBody } = {}) {
  if (!logBag) return logBag
  logBag.protocol = WASHED_OPENAI_PROTOCOL
  logBag.path = WASHED_OPENAI_PATH
  logBag.hop_meta = {
    ...(logBag.hop_meta && typeof logBag.hop_meta === 'object' ? logBag.hop_meta : {}),
    ...washedOpenaiHopMeta({ inboundPath, inboundProtocol, converted }),
  }
  if (outboundBody != null) {
    const publicBody = publicWashedResponsesBody(outboundBody)
    logBag.outbound_summary = summarizeWashedResponses(publicBody)
    logBag.outbound_body = publicBody
  }
  return logBag
}
