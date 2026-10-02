import { CLAUDE_CODE_SECURITY_MONITOR_PREFIX } from '../identity/crs-persona.mjs'
import { getModelEntry } from './model-policy.mjs'
import { officialMessagesBody } from './anthropic-messages.mjs'
import { stripIllegalCacheControlFields } from './cache-ttl.mjs'

function textOf(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.map((b) => (b?.type === 'text' ? b.text : '')).join('') : ''
}

/** Purpose is derived from the original contract, never from a public header/context. */
export function classifyClaudeRequestPurpose(body, { officialTraffic = false } = {}) {
  if (!officialTraffic) return null
  const system = Array.isArray(body?.system)
    ? body.system
        .map((block) => textOf([block]))
        .find((text) => text.trimStart().startsWith(CLAUDE_CODE_SECURITY_MONITOR_PREFIX)) || ''
    : textOf(body?.system)
  if (!system.trimStart().startsWith(CLAUDE_CODE_SECURITY_MONITOR_PREFIX)) return null
  if (
    !['## Threat Model', '## HARD BLOCK', '## SOFT BLOCK', '## Classification Process', '## Output Format'].every((s) =>
      system.includes(s),
    )
  )
    return null
  const last = Array.isArray(body.messages) ? body.messages.at(-1) : null
  if (last?.role !== 'user') return null
  const content = textOf(last.content)
  // The action is a compact tool record (plain or JSONL), after user history.
  const action = content.split('</transcript>')[0].trim().split('\n').at(-1)
  if (!/^(?:(?!User:)[A-Za-z][\w.:-]* [^\n]+|\{(?!"user":)"[^"\n]+":)/.test(action || '')) return null
  if (
    system.includes('<block>yes</block>') &&
    system.includes('<block>no</block>') &&
    content.includes('<transcript>') &&
    content.includes('</transcript>')
  ) {
    const context = { purpose: 'auto_mode_classifier', format: 'xml' }
    if (content.includes('Use <thinking> before responding with <block>.')) context.stage = 'xml_s2'
    else if (content.includes('Err on the side of blocking. <block> immediately.')) {
      if (body.stop_sequences?.includes('</block>')) context.stage = 'xml_s1'
      else context.stage = 'fast'
    }
    return context
  }
  const tool = body.tools?.find((t) => t?.name === 'classify_result')
  const schema = tool?.input_schema
  if (
    system.includes('Use the classify_result tool to report your classification.') &&
    body.tool_choice?.type === 'tool' &&
    body.tool_choice.name === 'classify_result' &&
    schema?.type === 'object' &&
    schema.properties?.shouldBlock?.type === 'boolean' &&
    ['thinking', 'reason'].every((k) => schema.properties?.[k]?.type === 'string') &&
    ['thinking', 'reason', 'shouldBlock'].every((k) => schema.required?.includes(k))
  ) {
    return { purpose: 'auto_mode_classifier', format: 'tool' }
  }
  return null
}

function incompatible(message, code = 'classifier_model_incompatible') {
  const error = new Error(message)
  error.status = 400
  error.body = { type: 'error', error: { type: 'invalid_request_error', code, message } }
  throw error
}

/** Both transports use this policy; repeated assembly never adds headroom twice. */
export function prepareClassifierBody(input, { stream = true } = {}) {
  const entry = getModelEntry(input.model)
  if (entry._heuristic) incompatible('Classifier model capabilities are unknown; specify a supported model explicitly.')
  if (input.max_tokens != null && (!Number.isInteger(input.max_tokens) || input.max_tokens <= 0))
    incompatible('Classifier max_tokens must be a positive integer.')
  let body = officialMessagesBody(input, { stream })
  body.model = entry.id
  const alwaysOn = entry.capabilities.requires_adaptive === true
  if (body.thinking && !['disabled', 'adaptive', 'enabled'].includes(body.thinking.type))
    incompatible('Invalid classifier thinking configuration.')
  if (body.thinking?.type === 'adaptive' && !entry.capabilities.supports_adaptive)
    incompatible('The selected classifier model does not support adaptive thinking.')
  if (
    body.thinking?.type === 'enabled' &&
    (!Number.isInteger(body.thinking.budget_tokens) ||
      body.thinking.budget_tokens < 1024 ||
      body.thinking.budget_tokens >= body.max_tokens)
  )
    incompatible('Classifier thinking budget must be at least 1024 and below max_tokens.')
  if (body.output_config?.effort != null && !entry.capabilities.supports_effort)
    incompatible('The selected classifier model does not support output effort.')
  if (alwaysOn && ['tool', 'any', 'required'].includes(body.tool_choice?.type)) {
    incompatible('The selected classifier model requires thinking and cannot honor forced classify_result tool choice.')
  }
  const cap = Number(entry.params.max_tokens_cap)
  if (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0 || body.max_tokens > cap)
    incompatible('Classifier max_tokens exceeds the selected model budget.')
  if (alwaysOn && body.thinking?.type === 'disabled') {
    if (body.max_tokens + 2048 > cap) incompatible('Classifier thinking headroom exceeds the selected model budget.')
    body.thinking = { type: 'adaptive' }
    body.max_tokens += 2048
  }
  if (alwaysOn && body.thinking?.type === 'enabled')
    incompatible('The selected classifier model requires adaptive thinking.')
  if (alwaysOn || ['enabled', 'adaptive'].includes(body.thinking?.type)) {
    delete body.temperature
    delete body.top_p
    delete body.top_k
    if (body.tool_choice?.type === 'tool')
      incompatible('Forced classifier tool choice cannot be combined with thinking.')
  }
  const blocks = [
    ...(body.tools || []),
    ...(Array.isArray(body.system) ? body.system : []),
    ...(body.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
  ]
  let markers = body.cache_control ? 1 : 0
  let short = false
  for (const block of blocks) {
    if (!block.cache_control) continue
    if (['thinking', 'redacted_thinking'].includes(block.type)) {
      delete block.cache_control
      continue
    }
    const { type, ttl } = block.cache_control
    if (type !== 'ephemeral' || (ttl != null && !['5m', '1h'].includes(ttl)))
      incompatible('Invalid classifier cache control.', 'classifier_invalid_cache')
    if (short && ttl === '1h') incompatible('Classifier cache TTL must place 1h before 5m.', 'classifier_invalid_cache')
    if (ttl !== '1h') short = true
    markers++
  }
  if (markers > 4) incompatible('Classifier cache control exceeds four breakpoints.', 'classifier_invalid_cache')
  body = stripIllegalCacheControlFields(body)
  return body
}

export function classifierRequestSummary(input, output, context) {
  const fields = (body) => ({
    model: body.model,
    max_tokens: body.max_tokens,
    thinking: body.thinking?.type || 'absent',
    temperature: body.temperature ?? null,
    tool_choice: body.tool_choice?.type || null,
  })
  return {
    ...context,
    layer: 'node_object',
    wire_observed: false,
    before: fields(input),
    after: fields(output),
    reason:
      input.thinking?.type === 'disabled' && output.thinking?.type === 'adaptive'
        ? 'model_requires_adaptive_headroom_2048'
        : 'preserve_classifier_contract',
  }
}
