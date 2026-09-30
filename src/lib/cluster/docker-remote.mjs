/**
 * Docker Engine HTTP API over a stream connector. Remote nodes use an SSH
 * `direct-streamlocal` channel to /var/run/docker.sock (no dockerd TCP, no agent
 * on the VPS: permissions are the SSH user's docker group); the control plane's
 * own daemon uses the local unix socket through the same code.
 */

import http from 'node:http'
import net from 'node:net'
import { ClusterError, forwardOutStreamLocal } from './ssh-link.mjs'

export const DOCKER_SOCKET_PATH = '/var/run/docker.sock'
const MAX_RESPONSE_BYTES = 8 << 20

/** @typedef {() => Promise<import('node:stream').Duplex>} DockerConnector */

/** @returns {DockerConnector} */
export function sshDocker(client) {
  return () => forwardOutStreamLocal(client, DOCKER_SOCKET_PATH)
}

/** @returns {DockerConnector} */
export function localDocker(socketPath = DOCKER_SOCKET_PATH) {
  return () =>
    new Promise((resolve, reject) => {
      const sock = net.connect(socketPath)
      sock.once('connect', () => resolve(sock))
      sock.once('error', (err) =>
        reject(new ClusterError(502, 'docker_unavailable', `本机 ${socketPath} 不可用：${err.message}`)),
      )
    })
}

/**
 * @param {DockerConnector} connect
 * @returns {Promise<{ status: number, headers: Record<string, string|string[]|undefined>, body: Buffer }>}
 */
export async function dockerRequest(connect, { method = 'GET', path, body, timeoutMs = 30_000, onChunk } = {}) {
  const stream = await connect()
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
  // One-shot agent: `agent: false` makes Node ignore `createConnection` and dial TCP.
  const agent = new http.Agent({ keepAlive: false })
  agent.createConnection = () => stream
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      path,
      host: 'docker',
      agent,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    })
    const timer = setTimeout(() => {
      req.destroy(new ClusterError(504, 'docker_timeout', `Docker API 超时：${method} ${path}`))
    }, timeoutMs)
    req.on('error', (err) => {
      clearTimeout(timer)
      stream.close?.()
      reject(
        err instanceof ClusterError
          ? err
          : new ClusterError(502, 'docker_io_failed', `Docker API 失败：${err.message}`),
      )
    })
    req.on('response', (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        if (onChunk) onChunk(chunk)
        if (size >= MAX_RESPONSE_BYTES) return
        size += chunk.length
        chunks.push(chunk)
      })
      res.on('end', () => {
        clearTimeout(timer)
        resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
      res.on('error', (err) => {
        clearTimeout(timer)
        reject(new ClusterError(502, 'docker_io_failed', `Docker API 读取失败：${err.message}`))
      })
    })
    req.end(payload || undefined)
  })
}

function dockerMessage(res) {
  const text = res.body.toString('utf8')
  try {
    return JSON.parse(text).message || text
  } catch {
    return text || `HTTP ${res.status}`
  }
}

export async function dockerJson(connect, opts, okStatuses = [200]) {
  const res = await dockerRequest(connect, opts)
  if (!okStatuses.includes(res.status)) {
    const status = res.status === 404 ? 404 : res.status === 409 ? 409 : 502
    throw new ClusterError(status, 'docker_api_error', dockerMessage(res))
  }
  if (!res.body.length) return null
  return JSON.parse(res.body.toString('utf8'))
}

/**
 * Split Docker's multiplexed log stream (non-TTY containers):
 * 8-byte header [stream, 0, 0, 0, size uint32 BE] + payload.
 * A trailing partial frame is dropped: it only happens when the read was cut.
 */
export function demuxDockerLog(buf) {
  const out = []
  let off = 0
  while (off + 8 <= buf.length) {
    const kind = buf[off]
    const size = buf.readUInt32BE(off + 4)
    if (kind > 2 || buf[off + 1] !== 0 || buf[off + 2] !== 0 || buf[off + 3] !== 0) break
    if (off + 8 + size > buf.length) break
    out.push({ stream: kind === 2 ? 'stderr' : 'stdout', text: buf.subarray(off + 8, off + 8 + size).toString('utf8') })
    off += 8 + size
  }
  return out
}

/** `nginx` → `nginx:latest`; keeps explicit tags, digests and registry ports. */
export function normalizeImageRef(image) {
  const ref = String(image || '').trim()
  if (ref.includes('@')) return ref
  const lastSlash = ref.lastIndexOf('/')
  return ref.slice(lastSlash + 1).includes(':') ? ref : `${ref}:latest`
}

const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESTART = new Set(['no', 'always', 'unless-stopped', 'on-failure'])

/**
 * Validate the panel's create-container form into an Engine API body.
 * @returns {{ name: string|null, image: string, body: object }}
 */
export function buildCreateSpec(input = {}) {
  const image = String(input.image || '').trim()
  if (!IMAGE_RE.test(image)) throw new ClusterError(400, 'invalid_image', '镜像名不合法')
  const name = input.name ? String(input.name).trim() : ''
  if (name && !NAME_RE.test(name)) throw new ClusterError(400, 'invalid_name', '容器名只能用字母数字和 _ . -')
  const restart = String(input.restart || 'unless-stopped')
  if (!RESTART.has(restart)) throw new ClusterError(400, 'invalid_restart', '重启策略不合法')

  const exposed = {}
  const bindings = {}
  for (const raw of input.ports || []) {
    const m = /^(?:(\d{1,3}(?:\.\d{1,3}){3}):)?(\d{1,5}):(\d{1,5})(?:\/(tcp|udp))?$/.exec(String(raw).trim())
    const hostPort = m ? Number(m[2]) : 0
    const containerPort = m ? Number(m[3]) : 0
    if (!m || hostPort < 1 || hostPort > 65535 || containerPort < 1 || containerPort > 65535) {
      throw new ClusterError(400, 'invalid_port', `端口映射不合法：${raw}（格式 主机端口:容器端口[/tcp|udp]）`)
    }
    const key = `${containerPort}/${m[4] || 'tcp'}`
    exposed[key] = {}
    bindings[key] = [...(bindings[key] || []), { HostIp: m[1] || '', HostPort: String(hostPort) }]
  }

  const env = []
  for (const raw of input.env || []) {
    const line = String(raw)
    const eq = line.indexOf('=')
    if (eq < 1 || !ENV_KEY_RE.test(line.slice(0, eq))) {
      throw new ClusterError(400, 'invalid_env', `环境变量不合法：${line}（格式 KEY=value）`)
    }
    env.push(line)
  }

  const cmd = Array.isArray(input.cmd) ? input.cmd.map(String).filter(Boolean) : []

  return {
    name: name || null,
    image: normalizeImageRef(image),
    body: {
      Image: normalizeImageRef(image),
      ...(env.length ? { Env: env } : {}),
      ...(cmd.length ? { Cmd: cmd } : {}),
      ExposedPorts: exposed,
      Labels: { 'vm2api.cluster': '1' },
      HostConfig: {
        PortBindings: bindings,
        RestartPolicy: { Name: restart },
      },
    },
  }
}

function containerView(c) {
  return {
    id: c.Id,
    name: String(c.Names?.[0] || '').replace(/^\//, ''),
    image: c.Image,
    state: c.State,
    status: c.Status,
    created_at: c.Created ? new Date(c.Created * 1000).toISOString() : null,
    ports: (c.Ports || [])
      .filter((p) => p.PublicPort)
      .map(
        (p) =>
          `${p.IP && p.IP !== '0.0.0.0' && p.IP !== '::' ? `${p.IP}:` : ''}${p.PublicPort}:${p.PrivatePort}/${p.Type}`,
      )
      .filter((v, i, all) => all.indexOf(v) === i),
    managed: c.Labels?.['vm2api.cluster'] === '1',
  }
}

const CONTAINER_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

function containerPath(id) {
  if (!CONTAINER_ID_RE.test(String(id || ''))) throw new ClusterError(400, 'invalid_container', '容器 ID 不合法')
  return `/containers/${encodeURIComponent(id)}`
}

export async function dockerPing(connect) {
  const res = await dockerRequest(connect, { path: '/_ping', timeoutMs: 10_000 })
  if (res.status !== 200) throw new ClusterError(502, 'docker_unavailable', dockerMessage(res))
  return true
}

export async function dockerInfo(connect) {
  const v = await dockerJson(connect, { path: '/version', timeoutMs: 10_000 })
  const info = await dockerJson(connect, { path: '/info', timeoutMs: 15_000 })
  return {
    version: v?.Version || null,
    api_version: v?.ApiVersion || null,
    os: info?.OperatingSystem || null,
    arch: info?.Architecture || null,
    cpus: info?.NCPU ?? null,
    mem_bytes: info?.MemTotal ?? null,
    containers: info?.Containers ?? null,
    running: info?.ContainersRunning ?? null,
    images: info?.Images ?? null,
  }
}

export async function listContainers(connect) {
  const rows = await dockerJson(connect, { path: '/containers/json?all=1' })
  return (rows || []).map(containerView)
}

async function pullImage(connect, image) {
  let streamError = null
  let tail = ''
  const res = await dockerRequest(connect, {
    method: 'POST',
    path: `/images/create?fromImage=${encodeURIComponent(image)}`,
    timeoutMs: 10 * 60_000,
    // Pull progress is NDJSON; failures after the 200 header only show up as errorDetail lines.
    onChunk: (chunk) => {
      tail = (tail + chunk.toString('utf8')).slice(-65536)
      const lines = tail.split('\n')
      tail = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const evt = JSON.parse(line)
          if (evt.error) streamError = evt.error
        } catch {}
      }
    },
  })
  if (res.status !== 200) throw new ClusterError(502, 'docker_pull_failed', dockerMessage(res))
  if (streamError) throw new ClusterError(502, 'docker_pull_failed', `拉取镜像失败：${streamError}`)
}

export async function createAndStartContainer(connect, input) {
  const spec = buildCreateSpec(input)
  const createPath = `/containers/create${spec.name ? `?name=${encodeURIComponent(spec.name)}` : ''}`
  let res = await dockerRequest(connect, { method: 'POST', path: createPath, body: spec.body })
  if (res.status === 404) {
    await pullImage(connect, spec.image)
    res = await dockerRequest(connect, { method: 'POST', path: createPath, body: spec.body })
  }
  if (res.status !== 201) {
    throw new ClusterError(res.status === 409 ? 409 : 502, 'docker_create_failed', dockerMessage(res))
  }
  const { Id: id } = JSON.parse(res.body.toString('utf8'))
  await containerAction(connect, id, 'start')
  return { id, name: spec.name, image: spec.image }
}

export async function containerAction(connect, id, action) {
  if (!['start', 'stop', 'restart'].includes(action)) {
    throw new ClusterError(400, 'invalid_action', '不支持的容器操作')
  }
  // 304 = already in the requested state; treat as success.
  await dockerJson(connect, { method: 'POST', path: `${containerPath(id)}/${action}`, timeoutMs: 60_000 }, [204, 304])
}

export async function removeContainer(connect, id) {
  await dockerJson(connect, { method: 'DELETE', path: `${containerPath(id)}?force=1&v=1`, timeoutMs: 60_000 }, [204])
}

export async function containerLogs(connect, id, { tail = 200 } = {}) {
  const n = Math.min(5000, Math.max(1, Number.parseInt(tail, 10) || 200))
  const inspect = await dockerJson(connect, { path: `${containerPath(id)}/json` })
  const res = await dockerRequest(connect, {
    path: `${containerPath(id)}/logs?stdout=1&stderr=1&timestamps=1&tail=${n}`,
  })
  if (res.status !== 200) throw new ClusterError(502, 'docker_api_error', dockerMessage(res))
  const lines = inspect?.Config?.Tty
    ? [{ stream: 'stdout', text: res.body.toString('utf8') }]
    : demuxDockerLog(res.body)
  return { tty: !!inspect?.Config?.Tty, lines }
}
