/**
 * Shared HTTP helpers for protocol and panel. SSE headers flush immediately
 * and optionally disable Nagle so Claude Code subagent tokens are not delayed.
 */
import { performance } from 'node:perf_hooks'
import { ErrorCode, ErrorType, makeError } from '../core/errors.mjs'
import { CORS_ALLOW_HEADERS, corsHeadersForRequest } from './cors.mjs'
import { finishJsonKeepalive } from './json-keepalive.mjs'

export { CORS_ALLOW_HEADERS } from './cors.mjs'

export function corsHeaders(extra = {}, req = null) {
  return corsHeadersForRequest(req, extra)
}

function requestFromResponse(res) {
  return res?.req || res?._kinReq || null
}

const requestBodyStates = new WeakMap()

// Only scalar metrics leave the WeakMap; bodies, headers and error messages do not.
// Read metrics stop at end/first failure; draining cannot change a failed snapshot.
// Before collection starts, there is no snapshot.
export function requestBodyMetrics(req) {
  const state = requestBodyStates.get(req)
  if (!state) return null
  return {
    ...state.metrics,
    read_ms: state.finished ? state.metrics.read_ms : performance.now() - state.startedAt,
  }
}

function collectBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const contentLength = req.headers?.['content-length']
    const expectedBytes =
      typeof contentLength === 'string' && contentLength.length > 0 && !/\D/.test(contentLength)
        ? Number(contentLength)
        : NaN
    const metrics = {
      expected_bytes: Number.isSafeInteger(expectedBytes) ? expectedBytes : null,
      received_bytes: 0,
      read_ms: 0,
      parse_ms: 0,
      complete: false,
      error_code: null,
    }
    const state = { metrics, startedAt, finished: false }
    requestBodyStates.set(req, state)
    const chunks = []
    let settled = false
    const finishRead = () => {
      state.finished = true
      metrics.read_ms = performance.now() - startedAt
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      finishRead()
      metrics.error_code = error.body.error.code
      chunks.length = 0
      req.resume()
      reject(error)
    }
    req.on('data', (c) => {
      if (settled) return
      metrics.received_bytes += c.length
      if (metrics.received_bytes > maxBytes) {
        fail(
          makeError({
            type: ErrorType.INVALID_REQUEST,
            code: ErrorCode.BODY_TOO_LARGE,
            message: `Request body exceeds limit of ${maxBytes} bytes`,
            status: 413,
            details: { max_bytes: maxBytes, received: metrics.received_bytes },
          }),
        )
        return
      }
      chunks.push(c)
    })
    req.once('end', () => {
      if (settled) return
      metrics.complete = true
      settled = true
      finishRead()
      resolve(Buffer.concat(chunks))
      chunks.length = 0
    })
    // IncomingMessage can emit error after aborted. Keep this listener even once
    // rejected, both to consume that error and to preserve the first failure.
    req.on('error', (e) =>
      fail(
        makeError({
          type: ErrorType.API,
          code: 'request_stream_error',
          message: String(e.message || e),
          status: 400,
        }),
      ),
    )
    req.once('aborted', () =>
      fail(
        makeError({
          type: ErrorType.API,
          code: 'request_aborted',
          message: 'Request body stream was aborted',
          status: 400,
        }),
      ),
    )
  })
}

export function readBody(req, maxBytes) {
  return collectBody(req, maxBytes).then((buf) => {
    const raw = buf.toString('utf8')
    if (!raw) return {}
    const metrics = requestBodyStates.get(req).metrics
    const parseStartedAt = performance.now()
    try {
      return JSON.parse(raw)
    } catch (e) {
      metrics.error_code = ErrorCode.INVALID_JSON
      throw makeError({
        type: ErrorType.INVALID_REQUEST,
        code: ErrorCode.INVALID_JSON,
        message: 'Request body is not valid JSON: ' + (e.message || 'parse error'),
        status: 400,
        details: { parse_error: String(e.message || e) },
      })
    } finally {
      metrics.parse_ms = performance.now() - parseStartedAt
    }
  })
}

/**
 * Node 的 WHATWG URL 会拒绝未加括号的 IPv6、非 ASCII Host、空 Host。
 * 安装探活打的是 127.0.0.1，浏览器若用这类 Host 打开 /cc，旧代码在进路由前就 500。
 * Host 解析失败时仍用路径路由；路径本身非法才返回 null。
 */
export function parseRequestUrl(req) {
  const raw = req?.url || '/'
  const host = String(req?.headers?.host || '').trim()
  const bases = []
  if (host) bases.push(`http://${host}`)
  bases.push('http://127.0.0.1')
  for (const base of bases) {
    try {
      return new URL(raw, base)
    } catch {
      // try the next base
    }
  }
  return null
}

export function readRawBody(req, maxBytes) {
  return collectBody(req, maxBytes)
}

export function applySseSocketTuning(res, { tcpNodelay = true } = {}) {
  if (typeof res.flushHeaders === 'function') {
    try {
      res.flushHeaders()
    } catch {}
  }
  if (tcpNodelay !== false) {
    try {
      res.socket?.setNoDelay?.(true)
    } catch {}
  }
}

export function createRespond(cfg, options = {}) {
  const resolveNodelay = () => {
    if (typeof options.tcpNodelay === 'function') return options.tcpNodelay() !== false
    return options.tcpNodelay !== false
  }

  function json(res, status, body) {
    if (finishJsonKeepalive(res, status, body)) return
    const data = JSON.stringify(body)
    const headers = corsHeadersForRequest(requestFromResponse(res), {
      'content-type': 'application/json; charset=utf-8',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    if (body?.error?.details?.retryable === false) headers['x-should-retry'] = 'false'
    res.writeHead(status, headers)
    res.end(data)
  }

  function writeSSEHeaders(res) {
    const headers = corsHeadersForRequest(requestFromResponse(res), {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-kin-rewrite': cfg.rewrite.enabled ? 'on' : 'off',
    })
    if (res._kinRequestId) headers['x-request-id'] = res._kinRequestId
    res.writeHead(200, headers)
    applySseSocketTuning(res, { tcpNodelay: resolveNodelay() })
  }

  return { json, writeSSEHeaders, readBody, readRawBody, corsHeaders }
}
