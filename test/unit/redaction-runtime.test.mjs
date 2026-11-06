import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureRedaction,
  maskJson,
  publishRedactionForTests,
  restoreJsonValue,
} from '../../src/lib/redaction/runtime.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-redact-runtime-'))
const suppliedBin = process.env.KIN_TEST_REDACT_BIN
const bin = suppliedBin || path.join(root, 'kin-redact')

let helper = null

afterEach(async () => {
  if (helper && helper.exitCode === null) {
    const stopped = new Promise((resolve) => helper.once('exit', resolve))
    helper.kill()
    await stopped
  }
  helper = null
  publishRedactionForTests(null)
})
after(() => fs.rmSync(root, { recursive: true, force: true }))

describe('redaction runtime', () => {
  it('stays out of the request path when the switch is off', async () => {
    const state = await ensureRedaction({}, { projectRoot: root, binPath: bin })
    assert.equal(state.enabled, false)
    assert.equal(state.ready, true)
    assert.deepEqual(
      await maskJson({ messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }] }, { principal: 'key-a' }),
      {
        messages: [{ role: 'user', content: 'sk-proj-Aa1Bb2Cc3Dd4Ee5Ff6Gg' }],
      },
    )
  })

  it('masks and restores through the real helper when enabled', { timeout: 60_000 }, async () => {
    if (!suppliedBin)
      execFileSync('go', ['build', '-o', bin, './cmd/kin-redact'], {
        cwd: path.join(process.cwd(), 'redact'),
        stdio: 'inherit',
      })
    const policy = { enabled: true, secrets: true, personal: false, words: [], rules: [] }
    const state = await ensureRedaction({ redaction: policy }, { projectRoot: root, binPath: bin })
    assert.equal(state.ready, true)
    helper = state.child
    const secret = 'sk-' + 'proj-' + 'Aa1Bb2Cc3Dd4Ee5Ff6Gg'
    const masked = await maskJson(
      { messages: [{ role: 'user', content: `token ${secret}` }] },
      { principal: 'key-a', session: 's1' },
    )
    const text = JSON.stringify(masked)
    assert.ok(!text.includes(secret))
    assert.ok(text.includes('{{R_API_KEY_'))
    const restored = await restoreJsonValue(masked, { principal: 'key-a', session: 's1' })
    assert.ok(JSON.stringify(restored).includes(secret))
    const other = await restoreJsonValue(masked, { principal: 'key-b', session: 's1' })
    assert.ok(!JSON.stringify(other).includes(secret))
  })
})
