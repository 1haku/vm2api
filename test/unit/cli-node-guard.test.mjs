import test from 'node:test'
import assert from 'node:assert/strict'
import { selectCliNodePidsToKill } from '../../src/lib/vm/cli-node-guard.mjs'

test('keeps the oldest worker and a cli-node whose panel shell is still open', () => {
  const kill = selectCliNodePidsToKill(
    [
      { pid: 20, worker: true },
      { pid: 8, worker: true },
      { pid: 30, worker: false, panelToken: 'live' },
      { pid: 31, worker: false, panelToken: 'gone' },
      { pid: 32, worker: false, panelToken: null },
    ],
    ['live'],
  )
  assert.deepEqual(
    kill.sort((a, b) => a - b),
    [20, 31, 32],
  )
})

test('kills every interactive cli-node when no panel shell is connected', () => {
  assert.deepEqual(
    selectCliNodePidsToKill(
      [
        { pid: 4, worker: true },
        { pid: 9, worker: false, panelToken: 'stale' },
      ],
      [],
    ),
    [9],
  )
})
