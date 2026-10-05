#!/usr/bin/env node
/**
 * Linux guest image provisioning. Ordinary linux-userland-image entries are
 * inspected, pulled, or built. VM disks and macOS launchers are not Docker
 * build contexts here. `--pull-only` never builds.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { OS_CATALOG } from '../../src/lib/vm/os-catalog.mjs'

const kinOsRoot = path.dirname(fileURLToPath(import.meta.url))
const FLAGS = new Set(['--force', '--pull', '--pull-only'])
const DEFAULT_TIMEOUTS = { inspect: 30_000, pull: 180_000, build: 1_200_000 }

export async function runKinOsBuild(argv, opts = {}) {
  const catalog = opts.catalog || OS_CATALOG
  const root = opts.root || kinOsRoot
  const spawn = opts.spawn || spawnBounded
  const command = opts.command || 'docker'
  const env = opts.env || process.env
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) }
  const stdout = []
  const stderr = []
  const say = (line) => {
    stdout.push(line)
    if (!opts.silent) console.log(line)
  }
  const warn = (line) => {
    stderr.push(line)
    if (!opts.silent) console.warn(line)
  }
  const fail = (code, payload) => {
    const line = JSON.stringify({ ok: false, ...payload })
    stderr.push(line)
    if (!opts.silent) console.error(line)
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
  }

  const args = Array.isArray(argv) ? argv : []
  const unknownFlags = args.filter((arg) => arg.startsWith('--') && !FLAGS.has(arg))
  if (unknownFlags.length) {
    return fail(2, {
      code: 'unknown_flag',
      selector: unknownFlags[0],
      action: 'Use --force, --pull, or --pull-only. Other flags are rejected.',
    })
  }
  const force = args.includes('--force')
  const pullOnly = args.includes('--pull-only')
  const pull = pullOnly || args.includes('--pull')
  const tokens = args.filter((arg) => arg && !arg.startsWith('--'))
  const selected = selectEntries(catalog, tokens)
  if (selected.error) return fail(2, selected.error)

  for (const [id, meta] of selected.skipped) {
    say(`vm2api: skip ${id} artifact ${kindOf(meta)}; this builder does not build VM disks or macOS launchers`)
  }

  for (const [id, meta] of selected.docker) {
    if (!force) {
      const inspected = await docker(spawn, command, ['image', 'inspect', meta.image], {
        env,
        timeout: timeouts.inspect,
        signal: opts.signal,
        stdio: 'pipe',
      })
      const failed = dockerFailure('inspect', inspected, timeouts.inspect)
      if (failed) return fail(failed.code, failed.payload)
      if (inspected.status === 0 && imageSatisfied(meta, inspected.stdout, root)) {
        say(`vm2api: skip existing ${meta.image}`)
        continue
      }
    }
    if (pull) {
      const pulled = await docker(spawn, command, ['pull', meta.image], {
        env,
        timeout: timeouts.pull,
        signal: opts.signal,
        stdio: opts.stdio || 'inherit',
      })
      const failed = dockerFailure('pull', pulled, timeouts.pull)
      if (failed) return fail(failed.code, failed.payload)
      if (pulled.status === 0) {
        const again = await docker(spawn, command, ['image', 'inspect', meta.image], {
          env,
          timeout: timeouts.inspect,
          signal: opts.signal,
          stdio: 'pipe',
        })
        const againFailed = dockerFailure('inspect', again, timeouts.inspect)
        if (againFailed) return fail(againFailed.code, againFailed.payload)
        if (again.status === 0 && imageSatisfied(meta, again.stdout, root)) continue
        if (pullOnly) {
          warn(pulledMismatchWarning(meta))
          continue
        }
      } else if (pullOnly) {
        warn(pullOnlyWarning(meta))
        continue
      }
    }
    const context = resolveContext(root, meta)
    if (context.error) return fail(1, { ...context.error, id })
    const built = await docker(spawn, command, ['build', '-f', context.dockerfile, '-t', meta.image, context.context], {
      env,
      timeout: timeouts.build,
      signal: opts.signal,
      stdio: opts.stdio || 'inherit',
    })
    const failed = dockerFailure('build', built, timeouts.build)
    if (failed) return fail(failed.code, failed.payload)
    if (built.status !== 0) {
      return fail(built.status || 1, {
        code: 'docker_failed',
        op: 'build',
        id,
        status: built.status,
        signal: built.signal || null,
        action: 'Inspect the Docker build output. A failed build does not change support.',
      })
    }
  }
  return { code: 0, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

function selectEntries(catalog, tokens) {
  const entries = Object.entries(catalog || {})
  if (!tokens.length) {
    return {
      docker: entries.filter(([, meta]) => isDockerLinux(meta)),
      skipped: entries.filter(([, meta]) => !isDockerLinux(meta)),
    }
  }
  const chosen = new Map()
  for (const token of tokens) {
    const hits = entries.filter(([id, meta]) => matches(id, meta, token))
    if (!hits.length) {
      return {
        error: {
          code: 'unknown_selector',
          selector: token,
          action: 'Pass an OS id, family, directory, runtime, arch, or artifact kind that exists in the catalog.',
        },
      }
    }
    if (hits.every(([, meta]) => !isDockerLinux(meta))) {
      return {
        error: {
          code: 'artifact_not_linux_image',
          selector: token,
          matches: hits.map(([id, meta]) => ({
            id,
            artifactKind: kindOf(meta),
            provider: meta.provider || null,
          })),
          action:
            'This builder only inspects, pulls, or builds Linux userland images. Do not build a macOS launcher or VM disk as a Linux image, and do not publish Apple system or recovery disks. Use the VM provider after license review.',
        },
      }
    }
    for (const hit of hits) {
      if (isDockerLinux(hit[1])) chosen.set(hit[0], hit)
    }
  }
  return { docker: [...chosen.values()], skipped: [] }
}

function matches(id, meta, token) {
  if (id === token || id.includes(token)) return true
  if (meta.dir && String(meta.dir).includes(token)) return true
  if (meta.family === token) return true
  if (meta.runtime === token || meta.provider === token) return true
  if (meta.arch === token) return true
  if (kindOf(meta) === token) return true
  return false
}

function kindOf(meta) {
  if (meta.artifactKind) return meta.artifactKind
  if (meta.artifact) return meta.artifact
  if (meta.image && meta.dir) return 'linux-userland-image'
  return 'unknown'
}

function isDockerLinux(meta) {
  if (kindOf(meta) !== 'linux-userland-image') return false
  if (!meta.image || !meta.dir) return false
  const provider = meta.provider || 'docker'
  return provider === 'docker' || provider === 'docker-linux'
}

function legacySupport(meta) {
  const support = meta.support || meta.supportLevel || ''
  return support === '' || support === 'supported'
}

function pullOnlyWarning(meta) {
  if (legacySupport(meta)) return `vm2api: ${meta.image} not pulled; will build on first slot start`
  return `vm2api: ${meta.image} not pulled; pull-only does not build and does not record support`
}

function pulledMismatchWarning(meta) {
  if (legacySupport(meta)) {
    return `vm2api: ${meta.image} pulled image does not match the pinned platform or digest; will build on first slot start`
  }
  return `vm2api: ${meta.image} pulled image does not match the pinned platform or digest; pull-only does not build and does not record support`
}

function resolveContext(root, meta) {
  const rel = meta.buildContext || meta.dir
  const context = path.resolve(root, rel)
  const relative = path.relative(root, context)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return {
      error: {
        code: 'build_context_escapes',
        context,
        action: 'Keep buildContext inside docker/kin-os. Do not use a cwd-relative path.',
      },
    }
  }
  const dockerfile = meta.dockerfile ? path.resolve(context, meta.dockerfile) : path.join(context, 'Dockerfile')
  if (!fs.existsSync(dockerfile) || !fs.statSync(dockerfile).isFile()) {
    return {
      error: {
        code: 'build_context_missing',
        context,
        dockerfile,
        action: 'Add the Linux Dockerfile for this catalog dir, or point buildContext at that directory.',
      },
    }
  }
  const dockerRelative = path.relative(context, dockerfile)
  if (dockerRelative.startsWith('..') || path.isAbsolute(dockerRelative)) {
    return {
      error: {
        code: 'build_context_escapes',
        context,
        dockerfile,
        action: 'The Dockerfile must stay inside its build context.',
      },
    }
  }
  return { context, dockerfile }
}

function imageSatisfied(meta, raw, root) {
  const info = parseInspect(raw)
  if (!info) return false
  const os = info.Os || info.os
  const arch = info.Architecture || info.architecture
  if (os !== 'linux') return false
  if (normArch(arch) !== normArch(meta.arch || 'amd64')) return false
  if (
    meta.accountContract &&
    (info.Config?.Labels?.['org.vm2api.account-contract'] !== meta.accountContract ||
      !info.Config?.Entrypoint?.includes('/usr/local/bin/kin-account-entrypoint'))
  )
    return false
  const pin = basePin(meta, root)
  if (pin) {
    const label = info.Config?.Labels?.['org.vm2api.base-digest'] || ''
    if (digestOf(label) !== pin) return false
  }
  const output = digestOf(meta.digest || meta.imageDigest || '')
  if (output) {
    const id = digestOf(info.Id || '')
    const repos = (info.RepoDigests || []).map((item) => digestOf(item))
    if (id !== output && !repos.includes(output)) return false
  }
  return true
}

function parseInspect(raw) {
  try {
    const parsed = JSON.parse(String(raw || ''))
    return Array.isArray(parsed) ? parsed[0] : parsed
  } catch {
    return null
  }
}

function basePin(meta, root) {
  const declared = digestOf(meta.baseDigest || meta.base || '')
  if (declared) return declared
  if (!meta.dir) return ''
  const file = path.resolve(root, meta.dir, 'Dockerfile')
  if (!fs.existsSync(file)) return ''
  const match = fs.readFileSync(file, 'utf8').match(/^FROM\s+\S+@(sha256:[0-9a-f]{64})/im)
  return match ? match[1].toLowerCase() : ''
}

function digestOf(value) {
  const match = String(value || '')
    .toLowerCase()
    .match(/sha256:[0-9a-f]{64}/)
  return match ? match[0] : ''
}

function normArch(value) {
  const arch = String(value || '')
  if (arch === 'x86_64' || arch === 'amd64') return 'amd64'
  if (arch === 'aarch64' || arch === 'arm64') return 'arm64'
  return arch
}

function docker(spawn, command, args, options) {
  return spawn(command, args, {
    env: options.env,
    timeout: options.timeout,
    signal: options.signal,
    killSignal: 'SIGTERM',
    stdio: options.stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : options.stdio,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
}

function spawnBounded(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error?.killed && error.signal === 'SIGTERM' && !options.signal?.aborted) error.code = 'ETIMEDOUT'
      resolve({
        stdout,
        stderr,
        status: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        signal: error?.signal || null,
        error: error && typeof error.code === 'string' ? error : null,
      })
    })
  })
}

function dockerFailure(op, result, timeout) {
  if (result?.error?.code === 'ABORT_ERR')
    return { code: 130, payload: { code: 'cancelled', op, action: 'Docker operation was cancelled' } }
  if (!result) {
    return {
      code: 1,
      payload: { code: 'spawn_error', op, action: 'The Docker process returned no result.' },
    }
  }
  if (result.error && result.error.code === 'ETIMEDOUT') {
    return {
      code: 124,
      payload: {
        code: 'timeout',
        op,
        timeout,
        signal: result.signal || 'SIGTERM',
        action: `Docker ${op} exceeded ${timeout}ms and was terminated.`,
      },
    }
  }
  if (result.error && result.error.code === 'ENOENT') {
    return {
      code: 127,
      payload: {
        code: 'docker_missing',
        op,
        error: result.error.message,
        action: 'Install Docker and ensure the docker command is on PATH.',
      },
    }
  }
  if (result.error) {
    return {
      code: 1,
      payload: {
        code: 'spawn_error',
        op,
        error: result.error.message,
        signal: result.signal || null,
        action: 'Docker could not be started. Fix the runtime error before retrying.',
      },
    }
  }
  if (result.signal) {
    return {
      code: signalCode(result.signal),
      payload: {
        code: 'signal',
        op,
        signal: result.signal,
        action: `Docker ${op} ended on ${result.signal}.`,
      },
    }
  }
  return null
}

function signalCode(signal) {
  if (signal === 'SIGKILL') return 137
  if (signal === 'SIGTERM') return 143
  return 1
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invokedDirectly) {
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())
  const result = await runKinOsBuild(process.argv.slice(2), { signal: controller.signal })
  process.exitCode = result.code
}
