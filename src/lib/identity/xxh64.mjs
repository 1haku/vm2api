/**
 * xxHash64 (XXH64). Matches Python `xxhash.xxh64(data, seed=...).intdigest()`.
 * Little-endian, unsigned 64-bit arithmetic.
 */
const MASK = 0xffffffffffffffffn
const PRIME64_1 = 0x9e3779b185ebca87n
const PRIME64_2 = 0xc2b2ae3d27d4eb4fn
const PRIME64_3 = 0x165667b19e3779f9n
const PRIME64_4 = 0x85ebca77c2b2ae63n
const PRIME64_5 = 0x27d4eb2f165667c5n

function rotl64(x, r) {
  return ((x << r) | (x >> (64n - r))) & MASK
}

function round(acc, input) {
  acc = (acc + ((input * PRIME64_2) & MASK)) & MASK
  acc = rotl64(acc, 31n)
  return (acc * PRIME64_1) & MASK
}

function mergeRound(acc, val) {
  acc ^= round(0n, val)
  return (acc * PRIME64_1 + PRIME64_4) & MASK
}

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  return Buffer.from(input ?? '')
}

/**
 * @param {Buffer|Uint8Array|string} input
 * @param {bigint|number|string} seed
 * @returns {bigint} unsigned 64-bit digest
 */
export function xxh64(input, seed = 0n) {
  const buf = asBuffer(input)
  const seed64 = BigInt(seed) & MASK
  const len = buf.length
  let p = 0
  let h64

  if (len >= 32) {
    let v1 = (seed64 + PRIME64_1 + PRIME64_2) & MASK
    let v2 = (seed64 + PRIME64_2) & MASK
    let v3 = seed64
    let v4 = (seed64 - PRIME64_1) & MASK
    const limit = len - 32
    while (p <= limit) {
      v1 = round(v1, buf.readBigUInt64LE(p))
      v2 = round(v2, buf.readBigUInt64LE(p + 8))
      v3 = round(v3, buf.readBigUInt64LE(p + 16))
      v4 = round(v4, buf.readBigUInt64LE(p + 24))
      p += 32
    }
    h64 = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & MASK
    h64 = mergeRound(h64, v1)
    h64 = mergeRound(h64, v2)
    h64 = mergeRound(h64, v3)
    h64 = mergeRound(h64, v4)
  } else {
    h64 = (seed64 + PRIME64_5) & MASK
  }

  h64 = (h64 + BigInt(len)) & MASK

  while (p + 8 <= len) {
    const k1 = round(0n, buf.readBigUInt64LE(p))
    h64 ^= k1
    h64 = (rotl64(h64, 27n) * PRIME64_1 + PRIME64_4) & MASK
    p += 8
  }

  if (p + 4 <= len) {
    h64 ^= (BigInt(buf.readUInt32LE(p)) * PRIME64_1) & MASK
    h64 = (rotl64(h64, 23n) * PRIME64_2 + PRIME64_3) & MASK
    p += 4
  }

  while (p < len) {
    h64 ^= (BigInt(buf[p]) * PRIME64_5) & MASK
    h64 = (rotl64(h64, 11n) * PRIME64_1) & MASK
    p += 1
  }

  h64 ^= h64 >> 33n
  h64 = (h64 * PRIME64_2) & MASK
  h64 ^= h64 >> 29n
  h64 = (h64 * PRIME64_3) & MASK
  h64 ^= h64 >> 32n
  return h64
}
