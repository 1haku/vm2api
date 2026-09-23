import test from 'node:test'
import assert from 'node:assert/strict'
import { clearCachePrefixSessions, trackCachePrefix } from '../../src/lib/protocol/cache-prefix.mjs'

const body = (system, ...texts) => ({
  tools: [{ name: 'Read' }],
  system: [{ type: 'text', text: system }],
  messages: texts.map((text, i) => ({ role: i % 2 ? 'assistant' : 'user', content: text })),
})

test('a growing conversation keeps its prefix', () => {
  clearCachePrefixSessions()
  assert.deepEqual(trackCachePrefix('s', body('p', 'u1'), 0), { turn: 1, break: null })
  assert.deepEqual(trackCachePrefix('s', body('p', 'u1', 'a1', 'u2'), 1), { turn: 2, break: null })
})

test('the first changed section is reported', () => {
  clearCachePrefixSessions()
  trackCachePrefix('s', body('p', 'u1', 'a1', 'u2'), 0)
  assert.deepEqual(trackCachePrefix('s', body('p2', 'u1', 'a1', 'u2', 'a2', 'u3'), 1).break, { section: 'system' })
  assert.deepEqual(trackCachePrefix('s', body('p2', 'u1', 'edited', 'u2', 'a2', 'u3'), 2).break, {
    section: 'messages',
    index: 1,
  })
  // Compaction or a client that dropped history is still a break.
  assert.deepEqual(trackCachePrefix('s', body('p2', 'u1'), 3).break, { section: 'messages', index: 1 })
})

test('an idle session past the longest TTL starts over', () => {
  clearCachePrefixSessions()
  trackCachePrefix('s', body('p', 'u1'), 0)
  assert.deepEqual(trackCachePrefix('s', body('other', 'u1'), 60 * 60_000), { turn: 1, break: null })
})
