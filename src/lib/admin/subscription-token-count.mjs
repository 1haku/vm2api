import { Tiktoken } from 'tiktoken/lite'
import o200k from 'tiktoken/encoders/o200k_base.json' with { type: 'json' }

let encoder
// Bound per-request CPU and per-piece BPE work, including adversarial unbroken
// strings. Beyond this budget the existing conservative byte heuristic applies.
// A ~500k-token coding transcript can exceed 2 MB. The former 1M-character
// budget silently reverted most of such a transcript to UTF-8/3, even though
// it comfortably fit the model context. Bound work above ordinary 1M-token
// contexts instead; retain the fallback for oversized/adversarial bodies.
const TOKENIZE_CHAR_BUDGET = 8_000_000
const CHUNK_CHARS = 2048

/** Local text estimate, not the provider's final token count. No network calls,
 * prompt storage or assumption of cache hits. Unknown/other providers retain
 * the byte heuristic. o200k is an approximation for newer OpenAI families.
 */
export function subscriptionTextCounter(useOpenAIEncoding) {
  let budget = useOpenAIEncoding ? TOKENIZE_CHAR_BUDGET : 0
  let tokens = 0
  let fallbackBytes = 0
  const chunks = new Map()
  return {
    add(text) {
      let offset = 0
      while (offset < text.length && budget > 0) {
        let end = Math.min(text.length, offset + CHUNK_CHARS, offset + budget)
        // Do not split surrogate pairs at a chunk boundary.
        const code = text.charCodeAt(end - 1)
        if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--
        if (end <= offset) break
        encoder ??= new Tiktoken(o200k.bpe_ranks, o200k.special_tokens, o200k.pat_str)
        // Token-like strings in user content are ordinary text, never control
        // tokens (and must not throw on literal <|endoftext|>, etc.).
        const chunk = text.slice(offset, end)
        let count = chunks.get(chunk)
        if (count == null) {
          count = encoder.encode_ordinary(chunk).length
          // Request-local only; release prompt fragments when counting ends.
          if (chunks.size < 256) chunks.set(chunk, count)
        }
        tokens += count
        budget -= end - offset
        offset = end
      }
      if (offset < text.length) fallbackBytes += Buffer.byteLength(text.slice(offset))
    },
    result() {
      return {
        // Keep headroom for chat serialization and model tokenizer differences.
        tokens: Math.ceil(tokens * 1.1 + (fallbackBytes / 3) * 1.25),
        text_tokens: tokens,
        fallback_bytes: fallbackBytes,
        method: useOpenAIEncoding ? 'o200k_estimate' : 'utf8_estimate',
      }
    },
  }
}

/** Recognized encrypted replay envelopes are opaque, not one token per
 * ciphertext byte. Estimate their volume with the same conservative bytes/3
 * +25% heuristic used for unknown text, after base64 expansion is removed.
 * This is NOT an exact count or a guaranteed upper bound: the provider may
 * compress, retain or discard reasoning. Never decrypt or tokenize ciphertext.
 * Preserve the 8192 allowance for large or unrecognized encodings.
 */
export function encryptedReasoningAllowance(value) {
  if (typeof value !== 'string') return 8192
  if (!value) return 0
  if (value.length >= 26215 || !/^gAAAAA[A-Za-z0-9_=-]+$/.test(value)) return 8192
  return Math.min(8192, Math.max(256, Math.ceil((value.length / 4) * 1.25)))
}
