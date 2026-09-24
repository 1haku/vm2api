/**
 * Codex hop from handle-protocol. Claude convert/pool/CRS never runs here.
 */
import path from 'node:path'
import { getVm, listVms, persistCodexUsage, syncCodexQuotaSchedule } from '../vm/vm-registry.mjs'
import { isValidVmId } from '../vm/vm-file.mjs'
import { isCodexProtocolAllowed, isCodexVm, normalizeCodexRouting } from './codex-route.mjs'
import { restrictCodexClient } from './codex-restriction.mjs'
import {
  responsesSseToChatChunk,
  responsesSseToAnthropicEvents,
  createAnthropicSseState,
  assembleCodexBodyFromSse,
  codexBodyToAnthropicMessage,
  toCodexResponses,
} from './codex-convert.mjs'
import { extraFromCodexHeaders, codexQuotaPark, CODEX_DEFAULT_PARK_MS } from './codex-usage.mjs'
import { extractOpenaiUsage } from './openai-usage.mjs'
import { streamCodexKernel } from '../transport/codex-kernel-client.mjs'
import { ensureCodexKernel, writeCodexKernelConfig } from '../transport/codex-kernel-supervisor.mjs'
import { boundProxyUrl } from '../vm/egress.mjs'
import { orderCodexSessionSlots, isCodexFailoverError, CODEX_FAILOVER_MAX } from '../pool/codex-slot-pool.mjs'
import { classifyUpstreamResult } from '../pool/upstream-error-policy.mjs'
import { unitCircuit } from '../pool/unit-circuit.mjs'
import { acquireOpenAISlot, releaseOpenAISlot, reportOpenAIAttempt } from '../pool/openai-account-runtime.mjs'
import { applyOpenaiWashLog } from './openai-wash.mjs'

function sessionFrom(req, body) {
  const headers = req.headers || {}
  return {
    session_id:
      headers['x-session-id'] ||
      headers['session-id'] ||
      headers['x-conversation-id'] ||
      body?.conversation_id ||
      body?.session_id ||
      null,
    previous_response_id: body?.previous_response_id || null,
  }
}

function pinnedVmId(req) {
  const pinVmRaw = String(req?.headers?.['x-kin-vm'] || '').trim()
  if (req?.apiKeyKind !== 'master') return null
  return isValidVmId(pinVmRaw) ? pinVmRaw : null
}

export function pickCodexCandidates(projectRoot, req, { stickyRouter = null, sessions = null, body = null } = {}) {
  const pin = pinnedVmId(req)
  if (pin) {
    const vm = getVm(projectRoot, pin)
    if (!vm || !isCodexVm(vm)) return { error: 'platform_mismatch', pin, ids: [] }
    return { ids: [vm.id], pin, sticky: false, sessionKey: null, stickyKeys: [] }
  }
  for (const item of listVms(projectRoot)) {
    if (!isCodexVm(item)) continue
    syncCodexQuotaSchedule(projectRoot, getVm(projectRoot, item.id) || item)
  }
  const stickyKeys = stickyRouter?.collectPoolKeys?.(req, body || {}, { platform: 'openai' }) || []
  const sessionKey = stickyRouter?.extractPoolKey?.(req, body || {}, { platform: 'openai' }) || stickyKeys[0] || null
  const bound = sessionKey ? stickyRouter?.resolve?.(sessionKey) : null
  const ordered = orderCodexSessionSlots(listVms(projectRoot), {
    boundVmId: bound?.vmId || null,
    sessionKey,
    sessionLimit: sessions,
  })
  if (bound?.vmId && sessionKey && !ordered.sticky && !ordered.error) {
    for (const key of stickyKeys.length ? stickyKeys : [sessionKey]) stickyRouter?.unbind?.(key)
  }
  return { ...ordered, sessionKey, stickyKeys }
}

function ingestCodexHop(projectRoot, vmId, result, now = Date.now()) {
  const headers = result?.headers || {}
  const extra = extraFromCodexHeaders(headers, now)
  let limitedUntil = null
  if (
    isCodexFailoverError(result) &&
    (Number(result?.status) === 429 || /usage_limit_reached/.test(String(result?.body?.error?.code || '')))
  ) {
    const park = extra ? codexQuotaPark(extra, now) : { limited: true, until: now + CODEX_DEFAULT_PARK_MS }
    limitedUntil = park.until || now + CODEX_DEFAULT_PARK_MS
  }
  if (!extra && !limitedUntil) return null
  return persistCodexUsage(projectRoot, vmId, { headers, extra, limitedUntil, now })
}

function execFor(projectRoot, vm) {
  return {
    vmId: vm.id,
    homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'),
    vm,
  }
}

export function isRetryableCodexTransport(result) {
  if (!result || result.ok === true) return false
  if (result.committed === true) return false
  const code = String(result.body?.error?.code || result.error_code || '')
  const msg = String(result.body?.error?.message || result.error || '')
  const status = Number(result.status) || 0
  if (result.transportError === true) return true
  if (status === 0) return true
  if (status === 502 && /upstream_transport|worker_transport|transport/i.test(`${code} ${msg}`)) return true
  return /upstream_transport|worker_transport_error/i.test(code)
}

/** Idle SOCKS / first hop 502 is retryable only before any SSE byte is committed. */
/** `response.service_tier` from a Responses SSE data line, if present. */
export function serviceTierFromSseLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:') || !line.includes('service_tier')) return null
  try {
    const ev = JSON.parse(line.slice(5).trim())
    const tier = ev?.response?.service_tier ?? ev?.service_tier
    return typeof tier === 'string' && tier ? tier : null
  } catch {
    return null
  }
}

/** Responses `usage` object from one SSE data line, if it carries token counts. */
export function usageFromSseLine(line) {
  if (typeof line !== 'string' || !line.startsWith('data:') || !line.includes('usage')) return null
  try {
    const ev = JSON.parse(line.slice(5).trim())
    const usage = ev?.response?.usage || ev?.usage
    return usage && typeof usage === 'object' ? usage : null
  } catch {
    return null
  }
}

function usageTokens(usage) {
  const extracted = extractOpenaiUsage(usage)
  if (!extracted) return 0
  return (
    (extracted.input_tokens || 0) +
    (extracted.output_tokens || 0) +
    (extracted.cached_tokens || 0) +
    (extracted.cache_write_tokens || 0)
  )
}

function preferUsage(left, right) {
  if (usageTokens(right) > usageTokens(left)) return right
  return left || right || null
}

export async function runCodexKernelHop({ hop, args = {}, onEvent } = {}) {
  let emitted = false
  const wrapped = async (line) => {
    emitted = true
    if (onEvent) await onEvent(line)
  }
  let result = await hop({ ...args, onEvent: wrapped })
  if (!result?.ok && !emitted && isRetryableCodexTransport(result)) {
    result = { ...(await hop({ ...args, onEvent: wrapped })), transport_retried: true }
  }
  return result
}

export async function handleCodexProtocol({
  req,
  res,
  protocol,
  ctx,
  inbound,
  logBag,
  stats,
  json,
  writeSSEHeaders,
  routing = {},
  projectRoot,
  ops = {},
  stickyRouter = null,
  sessions = null,
  body = null,
}) {
  const codex = normalizeCodexRouting(routing.codex)
  const allowed = isCodexProtocolAllowed(protocol, { codex })
  if (!allowed.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = allowed.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: allowed.code,
        message: `protocol '${protocol}' is not allowed on the Codex hop`,
      },
    })
  }
  const restriction = restrictCodexClient(req.headers, ctx.body || inbound, { codex }, protocol)
  if (!restriction.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = restriction.code
    return json(res, 403, {
      error: { type: 'permission_error', code: restriction.code, message: restriction.message },
    })
  }
  const converted = toCodexResponses(protocol, ctx.body, codex.convert)
  if (!converted.ok) {
    stats.errors++
    logBag.via = 'codex-kernel'
    applyOpenaiWashLog(logBag, {
      inboundPath: ctx.path,
      inboundProtocol: protocol,
      converted: false,
    })
    logBag.error_code = converted.code
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: converted.code,
        message: 'request could not be converted to Codex Responses',
      },
    })
  }
  applyOpenaiWashLog(logBag, {
    inboundPath: ctx.path,
    inboundProtocol: protocol,
    converted: converted.converted,
    outboundBody: converted.body,
  })
  const picked = pickCodexCandidates(projectRoot, req, {
    stickyRouter,
    sessions,
    body: body || converted.body || inbound,
  })
  if (picked.error === 'platform_mismatch') {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = 'platform_mismatch'
    return json(res, 400, {
      error: {
        type: 'invalid_request_error',
        code: 'platform_mismatch',
        message: `vm '${picked.pin}' is not a GPT slot`,
      },
    })
  }
  if (
    picked.error === 'session_window_full' ||
    picked.error === 'quota_exhausted' ||
    picked.error === 'capacity_unavailable'
  ) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = picked.error
    const message =
      picked.error === 'session_window_full'
        ? 'OpenAI 号池的会话窗口已满'
        : picked.error === 'quota_exhausted'
          ? 'OpenAI 号池额度已耗尽'
          : 'OpenAI 号池并发已满'
    return json(res, 503, {
      error: {
        type: 'api_error',
        code: picked.error,
        message,
      },
    })
  }
  const candidateIds = (picked.ids || []).slice(0, CODEX_FAILOVER_MAX)
  if (!candidateIds.length) {
    stats.errors++
    logBag.via = 'codex-kernel'
    logBag.error_code = picked.error || 'no_codex_vm'
    return json(res, 503, {
      error: { type: 'api_error', code: picked.error || 'no_codex_vm', message: 'no Codex kernel VM is configured' },
    })
  }
  logBag.via = 'codex-kernel'
  stats.requests++
  stats.by_route[protocol] = (stats.by_route[protocol] || 0) + 1

  const stream = inbound?.stream !== false && ctx.body?.stream !== false
  const session = sessionFrom(req, converted.body)
  const outboundBody = { ...converted.body, stream: true }
  const hop = ops.streamCodexKernel || streamCodexKernel
  const writeCfg = ops.writeCodexKernelConfig || writeCodexKernelConfig
  const ensure = ops.ensureCodexKernel || ensureCodexKernel
  const anthropicSse = protocol === 'anthropic.messages' ? createAnthropicSseState() : null
  const chatSse =
    protocol === 'openai.chat' || protocol === 'openai.completions' ? { id: 'codex', seq: 0, tools: new Map(), sawTool: false } : null
  const stickyKeys = picked.stickyKeys?.length ? picked.stickyKeys : picked.sessionKey ? [picked.sessionKey] : []
  const bindSticky = (vm) => {
    if (!picked.sessionKey) return
    if (stickyRouter?.bind) {
      for (const key of stickyKeys) stickyRouter.bind(key, { accountId: vm.id, vmId: vm.id })
    }
    try {
      sessions?.touch?.(vm.id, picked.sessionKey)
    } catch {}
  }
  const leaveSticky = (vm) => {
    try {
      sessions?.drop?.(vm.id, picked.sessionKey)
    } catch {}
    if (!stickyRouter?.unbind || !picked.sessionKey) return
    for (const key of stickyKeys) stickyRouter.unbind(key)
  }
  let last = null
  for (let i = 0; i < candidateIds.length; i++) {
    const vm = getVm(projectRoot, candidateIds[i])
    if (!vm || !isCodexVm(vm)) continue
    const circuit = unitCircuit.admit(vm.id)
    if (!circuit.ok) {
      last = {
        ok: false,
        status: 503,
        committed: false,
        body: { error: { type: 'api_error', code: circuit.reason, message: 'Codex credential circuit is open' } },
      }
      continue
    }
    logBag.vm_id = vm.id
    writeCfg(projectRoot, vm, {
      proxyUrl: boundProxyUrl(vm.proxy),
      proxyRequired: true,
    })
    const ready = await ensure(execFor(projectRoot, vm))
    if (!ready?.ok) {
      last = {
        ok: false,
        status: 503,
        committed: false,
        body: {
          error: {
            type: 'api_error',
            code: 'codex_kernel_unavailable',
            message: `Codex kernel 未就绪（${ready?.reason || 'not_ready'}）。GPT 槽走独立 kernel，不是 wrap cli-hop。`,
          },
        },
      }
      unitCircuit.releaseProbe(vm.id)
      if (i + 1 < candidateIds.length && !res.headersSent) {
        leaveSticky(vm)
        continue
      }
      stats.errors++
      logBag.error_code = 'codex_kernel_unavailable'
      return json(res, 503, last.body)
    }
    acquireOpenAISlot(vm.id)
    let attemptKind = 'failed'
    try {
      const chunks = []
      let responseServiceTier = null
      let streamedUsage = null
      const result = await runCodexKernelHop({
        hop,
        args: {
          exec: execFor(projectRoot, vm),
          body: outboundBody,
          reqHeaders: req.headers,
          envelope: {
            body: outboundBody,
            stream: true,
            session,
          },
        },
        onEvent: async (line) => {
          const tier = serviceTierFromSseLine(line)
          if (tier) responseServiceTier = tier
          const seen = usageFromSseLine(line)
          if (seen) streamedUsage = preferUsage(streamedUsage, seen)
          if (!stream) {
            chunks.push(line)
            return
          }
          if (!res.headersSent) writeSSEHeaders(res)
          if (protocol === 'openai.chat' || protocol === 'openai.completions') {
            const mapped = responsesSseToChatChunk(line, 'codex', chatSse)
            if (mapped) res.write(mapped)
            return
          }
          if (protocol === 'anthropic.messages') {
            const mapped = responsesSseToAnthropicEvents(line, anthropicSse)
            if (mapped) res.write(mapped)
            return
          }
          res.write(line.endsWith('\n') ? `${line}\n` : `${line}\n`)
        },
      })
      ingestCodexHop(projectRoot, vm.id, result)
      if (result?.transport_retried) logBag.transport_retried = true
      last = result
      const hopUsage = result.usage || result.body?.usage || result.body?.response?.usage || null
      const usage = preferUsage(hopUsage, streamedUsage)
      // Responses SSE is not a Claude assistant message, so the stream client
      // reports ok:false / incomplete. A 200 hop that carried tokens still billed.
      const delivered = result?.ok || (Number(result?.status) === 200 && usageTokens(usage) > 0)
      if (delivered) {
        attemptKind = 'succeeded'
        unitCircuit.recordSuccess(vm.id)
        bindSticky(vm)
        const extracted = extractOpenaiUsage(usage)
        const serviceTier = responseServiceTier || converted.body?.service_tier || usage?.service_tier || null
        logBag.usage = usage && serviceTier ? { ...usage, service_tier: serviceTier } : usage
        logBag.input_tokens = extracted?.input_tokens ?? usage?.input_tokens ?? usage?.prompt_tokens ?? null
        logBag.output_tokens = extracted?.output_tokens ?? usage?.output_tokens ?? usage?.completion_tokens ?? null
        logBag.cache_read_tokens =
          extracted?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens ?? usage?.cache_read_tokens ?? null
        logBag.cache_creation_tokens =
          extracted?.cache_write_tokens ??
          usage?.input_tokens_details?.cache_write_tokens ??
          usage?.cache_creation_tokens ??
          null
        logBag.first_token_ms = result.ttftMs ?? null
        reportOpenAIAttempt(vm.id, 'succeeded', result.ttftMs ?? null)
        logBag.final_state = result?.ok ? result.terminalState || 'verified' : 'verified'
        logBag.upstream_model = converted.body.model
        if (i > 0) logBag.codex_failed_over = true
        if (!stream) {
          const assembled = assembleCodexBodyFromSse(chunks, result.body || {})
          const body =
            protocol === 'anthropic.messages' ? codexBodyToAnthropicMessage(assembled, converted.body.model) : assembled
          return json(res, 200, body)
        }
        if (!res.headersSent) writeSSEHeaders(res)
        return res.end()
      }
      if (res.headersSent) {
        reportOpenAIAttempt(vm.id, attemptKind, result?.ttftMs ?? null)
        stats.errors++
        logBag.error_code = result?.body?.error?.code || 'codex_upstream'
        logBag.upstream_status = result?.status || 0
        return res.end()
      }
      const policy = classifyUpstreamResult(result, { hasRefresh: !!vm?.has_refresh || !!vm?.codex?.refresh_token })
      if (policy.circuit) unitCircuit.recordFailure(vm.id)
      else unitCircuit.releaseProbe(vm.id)
      const switchUnit =
        policy.decision?.action === 'next_unit' ||
        policy.decision?.action === 'retry_same' ||
        isCodexFailoverError(result)
      if (i + 1 < candidateIds.length && switchUnit && policy.decision?.action !== 'return') {
        reportOpenAIAttempt(vm.id, attemptKind, result?.ttftMs ?? null)
        leaveSticky(vm)
        continue
      }
      reportOpenAIAttempt(vm.id, attemptKind, result?.ttftMs ?? null)
      break
    } finally {
      releaseOpenAISlot(vm.id)
    }
  }
  stats.errors++
  logBag.error_code = last?.body?.error?.code || 'codex_upstream'
  logBag.upstream_status = last?.status || 0
  return json(res, last?.status || 502, last?.body || { error: { type: 'api_error', code: 'codex_upstream' } })
}
