import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { servePoolSeatStream } from '../../src/lib/admin/pool-seat-stream.mjs'

function response() {
  const res = new EventEmitter()
  res.frames = []
  res.write = (frame) => {
    if (frame.startsWith('event: seats')) {
      res.frames.push(JSON.parse(frame.split('data: ')[1]))
      res.emit('frame')
    }
    return true
  }
  return res
}

test('seat route scopes all snapshots to owned slots and denies client API keys', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seat-scope-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  for (const [id, owner_user_id] of [
    ['alice-slot', 'alice'],
    ['bob-slot', 'bob'],
    ['shared-slot', null],
  ])
    fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify({ id, owner_user_id }))
  const scheduler = new EventEmitter()
  const seats = Object.fromEntries(
    ['alice-slot', 'bob-slot', 'shared-slot'].map((id) => [id, { seats_used: 1, holds: 2, queue_depth: 3 }]),
  )
  scheduler.seatSnapshot = () => ({ seats, global_queue_depth: 7, queue_max: 50 })
  const handler = createPanelHandler({
    cfg: { paths: { project: root } },
    poolScheduler: scheduler,
    requireAuth: () => true,
    writeSSEHeaders: (res) => {
      res.statusCode = 200
    },
    json: (res, status) => {
      res.statusCode = status
    },
  })
  for (const [identity, expected] of [
    [{ panelUser: 'alice', panelUserId: 'alice', panelRole: 'user' }, ['alice-slot']],
    [{ panelUser: 'bob', panelUserId: 'bob', panelRole: 'user' }, ['bob-slot']],
    [{ panelUser: 'missing', panelRole: 'user' }, []],
    [{ panelUser: 'admin', panelRole: 'admin' }, Object.keys(seats)],
    [{ panelUser: 'operator', panelRole: 'super' }, Object.keys(seats)],
    [{ apiKeyKind: 'master' }, Object.keys(seats)],
    [{ apiKeyKind: 'managed' }, null],
  ]) {
    const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, ...identity })
    const res = response()
    try {
      await handler(req, res, new URL('http://localhost/api/panel/pool/stream'))
      assert.equal(res.statusCode, expected ? 200 : 403)
      if (expected) {
        assert.deepEqual(Object.keys(res.frames[0].seats), expected)
        assert.equal(res.frames[0].global_queue_depth, identity.panelRole === 'user' ? 0 : 7)
        assert.equal(res.frames[0].queue_max, identity.panelRole === 'user' ? 0 : 50)
      } else assert.deepEqual(res.frames, [])
    } finally {
      req.emit('close')
    }
    assert.equal(scheduler.listenerCount('change'), 0)
  }
})

test('stream refreshes visibility on updates and frees scheduler listeners on disconnect', async () => {
  const scheduler = new EventEmitter()
  let visible = new Set(['mine'])
  scheduler.seatSnapshot = () => ({ seats: { mine: { seats_used: 1 }, other: { seats_used: 3 } } })
  const req = new EventEmitter(),
    res = response()
  try {
    servePoolSeatStream({
      req,
      res,
      getScheduler: () => scheduler,
      writeSSEHeaders() {},
      visibleVmIds: () => visible,
      throttleMs: 1,
    })
    assert.deepEqual(Object.keys(res.frames[0].seats), ['mine'])
    visible = new Set()
    const next = once(res, 'frame', { signal: AbortSignal.timeout(2000) })
    scheduler.emit('change')
    await next
    assert.deepEqual(res.frames[1].seats, {})
  } finally {
    res.emit('close')
  }
  assert.equal(scheduler.listenerCount('change'), 0)
})
