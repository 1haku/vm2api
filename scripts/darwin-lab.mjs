#!/usr/bin/env node
/**
 * Isolated open-source Darwin VM lab: prepare / start / inspect / stop / destroy / check-product.
 * Never touches slots, the gateway, Docker or vms/. Licensed macOS is refused here.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DARWIN_LAB_PROFILES,
  destroyInstance,
  inspectInstance,
  openLab,
  prepareBase,
  startInstance,
  stopInstance,
} from '../src/lib/vm/darwin-lab.mjs'
import { inspectMachOFile, staticDarwinVerdict } from '../src/lib/vm/darwin-macho.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const USAGE = `Usage: darwin-lab.mjs <command> --lab-root <dir> [options]
  prepare        --variant <id> --source <file inside lab root>
  start          --id <instance> --variant <id> --qemu-root <dir> [--memory-mib N] [--cpus N] [--accel kvm|tcg] [--payload-disk <raw disk inside lab root>]
  inspect        --id <instance> [--screendump]
  stop           --id <instance> [--timeout-s N]
  destroy        --id <instance>
  check-product  --variant <id> --file <Mach-O>   (static only; never proves the product runs)
Variants: ${Object.keys(DARWIN_LAB_PROFILES).join(', ')}`

const COMMANDS = {
  prepare: { values: ['lab-root', 'variant', 'source'], flags: [] },
  start: {
    values: ['lab-root', 'id', 'variant', 'qemu-root', 'memory-mib', 'cpus', 'accel', 'payload-disk'],
    flags: [],
  },
  inspect: { values: ['lab-root', 'id'], flags: ['screendump'] },
  stop: { values: ['lab-root', 'id', 'timeout-s'], flags: [] },
  destroy: { values: ['lab-root', 'id'], flags: [] },
  'check-product': { values: ['variant', 'file'], flags: [] },
}

function usage(message) {
  return Object.assign(new Error(`${message}\n${USAGE}`), { code: 'darwin_lab_usage' })
}

function parse(argv) {
  const [command, ...rest] = argv
  const spec = COMMANDS[command]
  if (!spec) throw usage(`Unknown command: ${command ?? '(none)'}`)
  const options = {}
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : null
    if (key && spec.flags.includes(key)) {
      options[key] = true
      continue
    }
    if (!key || !spec.values.includes(key) || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) {
      throw usage(`Unexpected argument: ${rest[i]}`)
    }
    options[key] = rest[i + 1]
    i += 1
  }
  return { command, options }
}

function integer(options, key) {
  if (options[key] === undefined) return undefined
  if (!/^\d+$/.test(options[key])) throw usage(`--${key} must be a positive integer`)
  return Number(options[key])
}

function required(options, key) {
  if (!options[key]) throw usage(`--${key} is required`)
  return options[key]
}

async function run({ command, options }) {
  if (command === 'check-product') {
    const profile = DARWIN_LAB_PROFILES[required(options, 'variant')]
    if (!profile) throw usage(`Unknown variant: ${options.variant}`)
    const info = inspectMachOFile(required(options, 'file'))
    return {
      file: path.resolve(options.file),
      variant: profile.id,
      macho: info,
      static: staticDarwinVerdict(info, profile.darwinMajor),
      runtime: 'unproven',
    }
  }
  const lab = openLab({
    labRoot: required(options, 'lab-root'),
    projectRoot,
    create: command === 'prepare',
    dataVolume: command === 'prepare' || command === 'start',
  })
  if (command === 'prepare') {
    return prepareBase(lab, { variant: required(options, 'variant'), source: required(options, 'source') })
  }
  const id = required(options, 'id')
  if (command === 'start') {
    return startInstance(lab, {
      id,
      variant: required(options, 'variant'),
      qemuRoot: required(options, 'qemu-root'),
      memoryMiB: integer(options, 'memory-mib'),
      cpus: integer(options, 'cpus'),
      accel: options.accel ?? 'kvm',
      payloadDisk: options['payload-disk'],
    })
  }
  if (command === 'inspect') return inspectInstance(lab, { id, screendump: options.screendump === true })
  if (command === 'stop') {
    const seconds = integer(options, 'timeout-s')
    return stopInstance(lab, { id, ...(seconds === undefined ? {} : { timeoutMs: seconds * 1000 }) })
  }
  return destroyInstance(lab, { id })
}

try {
  const result = await run(parse(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  const { code = 'darwin_lab_failed', message, ...detail } = error
  process.stderr.write(`${JSON.stringify({ error: code, message, ...detail }, null, 2)}\n`)
  process.exitCode = code === 'darwin_lab_usage' ? 2 : 1
}
