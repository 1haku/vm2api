/**
 * Control-plane version, changelog, and GitHub release check.
 * Host one-click upgrade lives in deploy/install.sh; the panel surfaces
 * the same command and (optionally) kicks it via docker.sock.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PROJECT = path.resolve(__dirname, '..', '..', '..')

export const GITHUB_REPO = 'dofastted/vm2api'
export const DEFAULT_HOST_ROOT = '/opt/vm2api'
export const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/deploy/install.sh`
export const DOCKER_SOCK = '/var/run/docker.sock'

const DEFAULT_CACHE_MS = 5 * 60 * 1000
const GITHUB_TIMEOUT_MS = 8000
const releaseCache = { at: 0, value: null, error: null }

export function projectRoot(explicit) {
  return explicit || process.env.KIN_PROJECT_ROOT || process.env.VM2API_HOST_ROOT || MODULE_PROJECT
}

export function readLocalVersion(root = projectRoot()) {
  const candidates = [
    path.join(root, 'VERSION'),
    path.join(MODULE_PROJECT, 'VERSION'),
    path.join(root, 'package.json'),
    path.join(MODULE_PROJECT, 'package.json'),
  ]
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      const raw = fs.readFileSync(file, 'utf8')
      if (file.endsWith('package.json')) {
        const ver = JSON.parse(raw).version
        if (ver) return normalizeVersion(ver) || '0.0.0'
        continue
      }
      const ver = normalizeVersion(raw.trim())
      if (ver) return ver
    } catch {
      // try next
    }
  }
  return '0.0.0'
}

export function normalizeVersion(value) {
  const m = String(value || '')
    .trim()
    .match(/^v?(\d+\.\d+\.\d+)$/)
  return m ? m[1] : ''
}

export function normalizeTag(value) {
  const ver = normalizeVersion(value)
  return ver ? `v${ver}` : ''
}

export function isReleaseTag(value) {
  return /^v\d+\.\d+\.\d+$/.test(String(value || '').trim())
}

export function compareSemver(a, b) {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1
    if (pa[i] < pb[i]) return -1
  }
  return 0
}

function parseSemver(value) {
  const n = normalizeVersion(value)
  const parts = n.split('.').map((x) => Number.parseInt(x, 10))
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function bulletsOf(body) {
  return String(body || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
}

function firstParagraph(body) {
  const block = String(body || '')
    .split(/\n\s*\n/)[0]
    ?.trim()
  if (!block) return ''
  if (block.startsWith('- ')) return ''
  return block
    .split('\n')
    .filter((line) => !line.trim().startsWith('- '))
    .join('\n')
    .trim()
}

export function parseChangelog(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n')
  const parts = text.split(/^## /m).slice(1)
  const entries = []
  for (const part of parts) {
    const nl = part.indexOf('\n')
    const heading = (nl === -1 ? part : part.slice(0, nl)).trim()
    const body = (nl === -1 ? '' : part.slice(nl + 1)).trim()
    if (/^unreleased$/i.test(heading)) {
      entries.push({
        version: 'unreleased',
        tag: null,
        date: null,
        heading,
        title: firstParagraph(body),
        body,
        bullets: bulletsOf(body),
        needs_wrap_cli_sync: /wrap-cli\/sync/i.test(body),
      })
      continue
    }
    const m = heading.match(/^v?(\d+\.\d+\.\d+)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})?/)
    if (!m) continue
    entries.push({
      version: m[1],
      tag: `v${m[1]}`,
      date: m[2] || null,
      heading,
      title: firstParagraph(body),
      body,
      bullets: bulletsOf(body),
      needs_wrap_cli_sync: /wrap-cli\/sync/i.test(body),
    })
  }
  return entries
}

export function loadChangelog(root = projectRoot()) {
  const candidates = [path.join(root, 'CHANGELOG.md'), path.join(MODULE_PROJECT, 'CHANGELOG.md')]
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue
      return parseChangelog(fs.readFileSync(file, 'utf8'))
    } catch {
      // try next
    }
  }
  return []
}

export function changelogSince(entries, currentVersion) {
  const current = normalizeVersion(currentVersion)
  return (entries || []).filter((entry) => {
    if (!entry?.version || entry.version === 'unreleased') return false
    return compareSemver(entry.version, current) > 0
  })
}

export function upgradeCommand(target) {
  const tag = normalizeTag(target)
  const flag = tag ? ` --version ${tag}` : ''
  return `curl -sSL ${INSTALL_SCRIPT_URL} | sudo bash -s -- upgrade${flag}`
}

export function defaultUpgradeCommand() {
  return upgradeCommand()
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'vm2api-release-check',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const token = process.env.GITHUB_TOKEN || process.env.VM2API_GITHUB_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export function publicRelease(payload) {
  if (!payload || typeof payload !== 'object') return null
  const tag = payload.tag_name || payload.tag || ''
  const version = normalizeVersion(tag)
  if (!version) return null
  return {
    version,
    tag: normalizeTag(version),
    name: payload.name || `vm2api ${version}`,
    html_url: payload.html_url || `https://github.com/${GITHUB_REPO}/releases/tag/${normalizeTag(version)}`,
    published_at: payload.published_at || payload.created_at || null,
    notes: String(payload.body || '').trim(),
  }
}

export async function fetchLatestRelease({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cacheMs = DEFAULT_CACHE_MS,
} = {}) {
  const ts = now()
  if (releaseCache.value && ts - releaseCache.at < cacheMs) {
    return { release: releaseCache.value, error: null, cached: true }
  }
  if (!fetchImpl) {
    return { release: releaseCache.value, error: 'fetch_unavailable', cached: false }
  }
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: githubHeaders(),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
    if (!res.ok) {
      const error = `github_http_${res.status}`
      releaseCache.at = ts
      releaseCache.error = error
      return { release: releaseCache.value, error, cached: false }
    }
    const release = publicRelease(await res.json())
    if (!release) {
      const error = 'github_empty'
      releaseCache.at = ts
      releaseCache.error = error
      return { release: releaseCache.value, error, cached: false }
    }
    releaseCache.at = ts
    releaseCache.value = release
    releaseCache.error = null
    return { release, error: null, cached: false }
  } catch (err) {
    const error = String(err?.message || err || 'github_unreachable')
    releaseCache.at = ts
    releaseCache.error = error
    return { release: releaseCache.value, error, cached: false }
  }
}

export function clearReleaseCache() {
  releaseCache.at = 0
  releaseCache.value = null
  releaseCache.error = null
}

export async function buildUpdateStatus({ projectRoot: root, fetchImpl, now, cacheMs } = {}) {
  const project = projectRoot(root)
  const current = readLocalVersion(project)
  const entries = loadChangelog(project)
  const remote = await fetchLatestRelease({ fetchImpl, now, cacheMs })
  const latest = remote.release?.version || current
  const newer = changelogSince(entries, current)
  const updateAvailable = compareSemver(latest, current) > 0
  const needsWrap = newer.some((entry) => entry.needs_wrap_cli_sync)
  return {
    current,
    current_tag: normalizeTag(current),
    latest,
    latest_tag: normalizeTag(latest),
    update_available: updateAvailable,
    html_url: remote.release?.html_url || `https://github.com/${GITHUB_REPO}/releases`,
    published_at: remote.release?.published_at || null,
    name: remote.release?.name || null,
    notes: remote.release?.notes || newer[0]?.title || '',
    changelog: newer,
    needs_wrap_cli_sync: needsWrap,
    upgrade_command: upgradeCommand(updateAvailable ? latest : ''),
    check_command: `sudo bash ${DEFAULT_HOST_ROOT}/deploy/install.sh check`,
    repo: GITHUB_REPO,
    source_error: remote.error,
  }
}

function which(cmd) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), '/usr/local/bin', '/usr/bin', '/bin']
  const seen = new Set()
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    const candidate = path.join(dir, cmd)
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // skip
    }
  }
  return null
}

export function hostRoot() {
  return process.env.VM2API_HOST_ROOT || DEFAULT_HOST_ROOT
}

export function canSpawnHostUpgrade({ dockerBin = which('docker'), sock = DOCKER_SOCK } = {}) {
  return Boolean(dockerBin && fs.existsSync(sock))
}

/**
 * Kick a host-side upgrade. The running control-plane container is replaced
 * by `docker compose up -d --build`, so the HTTP request may die mid-flight.
 * Callers should POST with { confirm: true } and then poll /health.
 */
export async function startHostUpgrade({
  projectRoot: root,
  confirm = false,
  version,
  spawnImpl = spawn,
  fetchImpl,
  now,
} = {}) {
  if (version != null && String(version).trim() !== '' && !normalizeTag(version)) {
    return {
      status: 400,
      error: { message: '无效版本', code: 'invalid_version' },
    }
  }
  const status = await buildUpdateStatus({ projectRoot: root, fetchImpl, now })
  const target = version ? normalizeTag(version) : status.latest_tag
  if (!isReleaseTag(target)) {
    return {
      status: 400,
      error: { message: '无效版本', code: 'invalid_version' },
    }
  }
  const command = upgradeCommand(target)
  if (!confirm) {
    return {
      status: 200,
      data: { ...status, started: false, target, command },
    }
  }
  if (!status.update_available && !version) {
    return {
      status: 200,
      data: { ...status, started: false, target, command, message: 'already_latest' },
    }
  }
  const dockerBin = which('docker')
  if (!canSpawnHostUpgrade({ dockerBin })) {
    return {
      status: 409,
      error: {
        message: '控制面容器里没有 docker.sock，请到宿主机执行一键更新命令',
        code: 'host_upgrade_required',
        command,
        target,
      },
      data: { ...status, started: false, target, command },
    }
  }
  const rootDir = hostRoot()
  const script = [
    'set -euo pipefail',
    'export GIT_TERMINAL_PROMPT=0',
    'command -v git >/dev/null || apk add --no-cache git >/dev/null',
    `git config --global --add safe.directory ${rootDir} || true`,
    'git fetch --tags origin',
    `git checkout -f ${target}`,
    'chmod 755 bin/kin-* 2>/dev/null || true',
    'grep -q "!CHANGELOG.md" .dockerignore 2>/dev/null || echo "!CHANGELOG.md" >> .dockerignore',
    'docker compose up -d --build',
  ].join('\n')
  const child = spawnImpl(
    dockerBin,
    [
      'run',
      '--rm',
      '--name',
      'vm2api-upgrade',
      '-v',
      `${rootDir}:${rootDir}`,
      '-v',
      `${DOCKER_SOCK}:${DOCKER_SOCK}`,
      '-w',
      rootDir,
      'docker:27-cli',
      'sh',
      '-c',
      script,
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref?.()
  return {
    status: 202,
    data: {
      ...status,
      started: true,
      target,
      command,
      message: 'upgrade_started',
    },
  }
}
