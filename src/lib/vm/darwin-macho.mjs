/** Static Mach-O x86_64 header reader: deployment target and dylib dependencies, never execution compatibility. */
import fs from 'node:fs'

const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const CPU_TYPE_X86_64 = 0x01000007
const LC_LOAD_DYLIB = 0xc
const LC_LOAD_WEAK_DYLIB = 0x80000018
const LC_REEXPORT_DYLIB = 0x8000001f
const LC_LAZY_LOAD_DYLIB = 0x20
const LC_RPATH = 0x8000001c
const LC_VERSION_MIN_MACOSX = 0x24
const LC_BUILD_VERSION = 0x32
const PLATFORM_MACOS = 1
const MAX_COMMANDS_BYTES = 16 * 1024 * 1024
const FILE_TYPES = { 1: 'object', 2: 'execute', 6: 'dylib', 8: 'bundle' }
const DYLIB_KINDS = {
  [LC_LOAD_DYLIB]: 'load',
  [LC_LOAD_WEAK_DYLIB]: 'weak',
  [LC_REEXPORT_DYLIB]: 'reexport',
  [LC_LAZY_LOAD_DYLIB]: 'lazy',
}

function version(value) {
  return `${value >>> 16}.${(value >>> 8) & 0xff}.${value & 0xff}`
}

/** macOS 10.x maps to Darwin x+4; macOS 11 and later map to Darwin major+9. */
export function darwinMajorForMacos(text) {
  const [major, minor] = String(text).split('.').map(Number)
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null
  return major === 10 ? minor + 4 : major + 9
}

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length)
  const got = fs.readSync(fd, buf, 0, length, offset)
  return got === length ? buf : buf.subarray(0, got)
}

function cstring(buf, start, end) {
  const nul = buf.indexOf(0, start)
  return buf.toString('utf8', start, nul >= 0 && nul < end ? nul : end)
}

/** Picks the x86_64 slice of a universal binary; other architectures cannot run on this guest. */
function sliceOffset(fd, head) {
  const magic = head.readUInt32BE(0)
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) return 0
  const count = head.readUInt32BE(4)
  const entry = magic === FAT_MAGIC ? 20 : 32
  const table = readAt(fd, 8, Math.min(count, 64) * entry)
  for (let i = 0; i < Math.min(count, 64); i += 1) {
    const at = i * entry
    if (at + entry > table.length) break
    if (table.readUInt32BE(at) !== CPU_TYPE_X86_64) continue
    return magic === FAT_MAGIC ? table.readUInt32BE(at + 8) : Number(table.readBigUInt64BE(at + 8))
  }
  return null
}

export function inspectMachOFile(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = readAt(fd, 0, 32)
    if (head.length < 8) return { format: 'not-mach-o' }
    const offset = sliceOffset(fd, head)
    if (offset === null) return { format: 'mach-o', error: 'no x86_64 slice' }
    const header = offset === 0 ? head : readAt(fd, offset, 32)
    if (header.length < 32 || header.readUInt32LE(0) !== MH_MAGIC_64) return { format: 'not-mach-o' }
    if (header.readUInt32LE(4) !== CPU_TYPE_X86_64) return { format: 'mach-o', error: 'not x86_64' }
    const ncmds = header.readUInt32LE(16)
    const sizeofcmds = header.readUInt32LE(20)
    if (sizeofcmds > MAX_COMMANDS_BYTES) return { format: 'mach-o', error: 'load commands exceed limit' }
    const cmds = readAt(fd, offset + 32, sizeofcmds)
    const result = {
      format: 'mach-o',
      arch: 'x86_64',
      filetype: FILE_TYPES[header.readUInt32LE(12)] || String(header.readUInt32LE(12)),
      platform: null,
      minos: null,
      sdk: null,
      dylibs: [],
      rpaths: [],
    }
    let at = 0
    for (let i = 0; i < ncmds; i += 1) {
      if (at + 8 > cmds.length) return { ...result, error: 'truncated load commands' }
      const cmd = cmds.readUInt32LE(at)
      const size = cmds.readUInt32LE(at + 4)
      if (size < 8 || at + size > cmds.length) return { ...result, error: 'malformed load command' }
      if (DYLIB_KINDS[cmd]) {
        result.dylibs.push({
          kind: DYLIB_KINDS[cmd],
          name: cstring(cmds, at + cmds.readUInt32LE(at + 8), at + size),
          compatibility: version(cmds.readUInt32LE(at + 20)),
        })
      } else if (cmd === LC_RPATH) {
        result.rpaths.push(cstring(cmds, at + cmds.readUInt32LE(at + 8), at + size))
      } else if (cmd === LC_BUILD_VERSION) {
        const platform = cmds.readUInt32LE(at + 8)
        result.platform = platform === PLATFORM_MACOS ? 'macos' : String(platform)
        result.minos = version(cmds.readUInt32LE(at + 12))
        result.sdk = version(cmds.readUInt32LE(at + 16))
      } else if (cmd === LC_VERSION_MIN_MACOSX) {
        result.platform = 'macos'
        result.minos = version(cmds.readUInt32LE(at + 8))
        result.sdk = version(cmds.readUInt32LE(at + 12))
      }
      at += size
    }
    return result
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * A deployment target newer than the guest kernel is a definite incompatibility.
 * Anything else is only "not excluded": loading and running inside the guest is the proof.
 */
export function staticDarwinVerdict(info, guestDarwinMajor) {
  if (info.format !== 'mach-o' || info.error) return { verdict: 'incompatible', reason: info.error || info.format }
  if (info.platform !== 'macos') return { verdict: 'incompatible', reason: `platform ${info.platform}` }
  const required = darwinMajorForMacos(info.minos)
  if (required === null) return { verdict: 'incompatible', reason: 'missing deployment target' }
  if (required > guestDarwinMajor)
    return {
      verdict: 'incompatible',
      reason: `requires Darwin ${required} (macOS ${info.minos})`,
      required_darwin: required,
    }
  return { verdict: 'not_excluded', required_darwin: required }
}
