import test from 'node:test'
import assert from 'node:assert/strict'
import { startGateway } from '../harness.mjs'

test('live seat SSE requires authentication and sends a snapshot before connection close', async () => {
  const gw = await startGateway()
  try {
    const path = gw.baseUrl + '/api/panel/pool/stream'
    const denied = await fetch(path)
    assert.equal(denied.status, 401)
    await denied.body.cancel()
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    let reader
    try {
      const result = await fetch(path, { headers: { authorization: `Bearer ${gw.apiKey}` }, signal: ctrl.signal })
      assert.equal(result.status, 200)
      assert.match(result.headers.get('content-type'), /text\/event-stream/)
      reader = result.body.getReader()
      let frames = ''
      while (!frames.includes('\n\n')) {
        const chunk = await reader.read()
        assert.equal(chunk.done, false)
        frames += new TextDecoder().decode(chunk.value)
      }
      assert.match(frames, /event: seats\ndata: /)
      const payload = JSON.parse(frames.split('data: ')[1].split('\n')[0])
      assert.equal(typeof payload.seats, 'object')
      assert.equal(typeof payload.ts, 'number')
    } finally {
      clearTimeout(timer)
      await reader?.cancel().catch(() => {})
      ctrl.abort()
    }
  } finally {
    await gw.stop()
  }
})
