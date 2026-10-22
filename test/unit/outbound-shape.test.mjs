import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkOfficial303Rules,
  diffShapes,
  isAllowedSkeletonDiff,
  outboundShape,
} from '../../src/lib/protocol/outbound-shape.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const SECRET_BODY = {
  model: 'claude-opus-5-5',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>\ntoken-SECRET /home/alice/project\n</system-reminder>\n' },
        { type: 'text', text: 'my password is hunter2', cache_control: { type: 'ephemeral' } },
      ],
    },
    { role: 'system', content: '# Environment\n - Primary working directory: /home/alice/project' },
  ],
  system: [
    { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.303.abc; cc_entrypoint=sdk-cli; cch=00000;' },
    {
      type: 'text',
      text: "You are Claude Code, Anthropic's official CLI for Claude.",
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: '\nYou are an agent working with the user toward their goals',
      cache_control: { type: 'ephemeral' },
    },
  ],
  tools: [{ name: 'Bash', input_schema: {} }],
  metadata: { user_id: '{"device_id":"deadbeef","session_id":"cafe"}' },
  max_tokens: 1000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'high' },
  stream: true,
}

test('shape keeps structure only: no prompt text, ids or secrets', () => {
  const shape = outboundShape(SECRET_BODY)
  const raw = JSON.stringify(shape)
  for (const leak of ['SECRET', 'hunter2', 'alice', 'deadbeef', 'cafe', 'agent working', 'cch=00000']) {
    assert.equal(raw.includes(leak), false, leak)
  }
  assert.deepEqual(
    shape.system.map((block) => block.kind),
    ['billing', 'identity', 'main'],
  )
  assert.deepEqual(shape.billing_fields, ['cc_version', 'cc_entrypoint', 'cch'])
  assert.equal(shape.messages[0].blocks[0].kind, 'reminder')
  assert.equal(shape.messages[1].kind, 'env')
  assert.equal(shape.markers.total, 3)
})

test('diff ignores lengths and reports structural changes by path', () => {
  const a = outboundShape(SECRET_BODY)
  const longer = structuredClone(SECRET_BODY)
  longer.messages[0].content[1].text += ' and more'
  assert.deepEqual(diffShapes(a, outboundShape(longer)), [])
  const moved = structuredClone(SECRET_BODY)
  delete moved.messages[0].content[1].cache_control
  moved.messages[1] = { role: 'system', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }
  const diffs = diffShapes(a, outboundShape(moved))
  assert.ok(diffs.some((diff) => diff.path === 'messages[0].blocks[1].cache_control'))
  assert.ok(diffs.length > 0)
})

test('303 rules flag a marked role=system, a missing billing slot and extra markers', () => {
  assert.deepEqual(checkOfficial303Rules(SECRET_BODY), [])
  const bad = structuredClone(SECRET_BODY)
  bad.system.shift()
  bad.messages[1] = { role: 'system', content: [{ type: 'text', text: 'env', cache_control: { type: 'ephemeral' } }] }
  bad.tools[0].cache_control = { type: 'ephemeral', ttl: '1h' }
  const problems = checkOfficial303Rules(bad)
  assert.ok(problems.some((p) => p.startsWith('system kinds')))
  assert.ok(problems.includes('tools carry markers'))
  assert.ok(problems.some((p) => p.includes('role=system carries a marker')))
})

test('skeleton diff: billing slot and conditional top-level fields are allowed, other top-level drift is not', () => {
  assert.equal(isAllowedSkeletonDiff({ path: 'system[0].kind' }), true)
  assert.equal(
    isAllowedSkeletonDiff({
      path: 'top_level',
      expected: ['model', 'stream'],
      actual: ['model', 'context_management', 'stream'],
    }),
    true,
  )
  assert.equal(
    isAllowedSkeletonDiff({
      path: 'top_level',
      expected: ['model', 'stream'],
      actual: ['model', 'temperature', 'top_p', 'stream'],
    }),
    false,
  )
  assert.equal(isAllowedSkeletonDiff({ path: 'stream' }), false)
})

test('cli: --shape and --against-profile run on a body file without printing text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbound-shape-'))
  const file = path.join(dir, 'body.json')
  fs.writeFileSync(file, JSON.stringify({ body: SECRET_BODY }))
  try {
    const shape = execFileSync(process.execPath, [path.join(ROOT, 'scripts/outbound-shape.mjs'), '--shape', file], {
      encoding: 'utf8',
    })
    assert.equal(shape.includes('hunter2'), false)
    assert.equal(JSON.parse(shape).markers.total, 3)
    const report = JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'scripts/outbound-shape.mjs'), '--against-profile', '2.1.303', file],
        {
          encoding: 'utf8',
        },
      ),
    )
    assert.deepEqual(report.blocking, [])
    assert.deepEqual(report.rules, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
