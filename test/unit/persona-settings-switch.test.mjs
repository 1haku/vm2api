/**
 * Settings page protocol switch → routing.json → unofficial /v1 outbound.
 *
 * Mirrors persistRoutingPatch (merge compatibility, write disk) and the
 * production applyCrsUnofficialPersona({ routingFile }) path. Mode is not
 * passed in — same as server.mjs.
 *
 * Console radios send only: rewrite | official_prompt | overwrite | zero | none.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyCrsUnofficialPersona,
  AGENT_EXPANSION_CACHE_CONTROL,
  CRS_AGENT_EXPANSION,
  CRS_AGENT_PROMPT_MINIMAL,
  CRS_AGENT_PROMPT_REQUIRED,
  CRS_EMPTY_IDENTITY_TEXT,
  CRS_OFFICIAL_AGENT_PROMPT,
  CRS_OFFICIAL_CLI_SYSTEM,
  CRS_OFFICIAL_SYSTEM,
  DEFAULT_CACHE_CONTROL_TTL,
  DEFAULT_PERSONA_MODE,
  normalizePersonaAgent,
  normalizePersonaMode,
  personaOptionsFromRoutingFile,
  wrapMandatoryConstraint,
} from '../../src/lib/identity/crs-persona.mjs'
import { DEFAULT_AGENT_STANDING } from '../../src/lib/identity/persona-template.mjs'

const SETTINGS_RADIOS = Object.freeze(['rewrite', 'official_prompt', 'overwrite', 'zero', 'none'])

const UNOFFICIAL = {
  model: 'claude-sonnet-5-5',
  messages: [{ role: 'user', content: 'hello from settings switch' }],
}

const SLOT = {
  timezone: 'America/Los_Angeles',
  locale: 'en_US.UTF-8',
  fingerprint: { timezone: 'America/Los_Angeles', locale: 'en_US.UTF-8' },
}

function firstUser(out) {
  const content = out.messages?.[0]?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('')
  }
  return content == null ? '' : String(content)
}

function envText(out) {
  return envTextAt(out)
}

function envTextAt(out) {
  const sys = Array.isArray(out.system) ? out.system : []
  const block = sys.find((b) => String(b?.text || '').includes('# Environment'))
  return String(block?.text || '')
}

function persistSettings(file, compatibility) {
  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  const next = {
    ...current,
    compatibility: { ...(current.compatibility || {}), ...compatibility },
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2))
  return personaOptionsFromRoutingFile(file)
}

function applyFromSettings(file, body = UNOFFICIAL, extra = {}) {
  return applyCrsUnofficialPersona(body, {
    officialClient: false,
    routingFile: file,
    identity: SLOT,
    model: body.model,
    ...extra,
  })
}

function withRouting(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-settings-switch-'))
  const file = path.join(dir, 'routing.json')
  try {
    return fn(file)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('settings radios are the five persisted persona_inject values', () => {
  assert.deepEqual(SETTINGS_RADIOS, ['rewrite', 'official_prompt', 'overwrite', 'zero', 'none'])
  for (const radio of SETTINGS_RADIOS) {
    assert.equal(normalizePersonaMode(radio), radio)
  }
  assert.equal(DEFAULT_PERSONA_MODE, 'rewrite')
})

test('settings hot-read legacy modes and current official/zero behavior without passing mode', () => {
  withRouting((file) => {
    for (const mode of ['rewrite', 'official_prompt', 'overwrite', 'zero', 'none']) {
      persistSettings(file, { persona_inject: mode, persona_park: true, persona_agent: 'default' })
      const out = applyFromSettings(file)
      assert.ok(firstUser(out).includes(UNOFFICIAL.messages[0].content), mode)
      if (mode === 'rewrite') {
        assert.equal(out.system[0].text, CRS_OFFICIAL_SYSTEM)
        assert.equal(out.system[1].text, CRS_AGENT_EXPANSION)
      }
      if (mode === 'official_prompt') {
        assert.equal(out.system.length, 4)
        assert.equal(out.system[1].text, CRS_OFFICIAL_CLI_SYSTEM)
        assert.ok(out.system[2].text.startsWith('\nYou are an agent working with the user'))
        assert.match(firstUser(out), /MANDATORY constraints/)
      }
      if (mode === 'overwrite') {
        assert.equal(out.system[1].text, CRS_OFFICIAL_AGENT_PROMPT)
        assert.match(envText(out), /Timezone: America\/Los_Angeles/)
      }
      if (mode === 'zero') {
        assert.equal(out.system.length, 1)
        assert.match(out.system[0].text, /prompt_version=<You are Claude Code/)
        assert.equal(firstUser(out), UNOFFICIAL.messages[0].content)
      }
      if (mode === 'none') {
        assert.equal(out.system, undefined)
        assert.equal(firstUser(out), UNOFFICIAL.messages[0].content)
      }
    }
  })
})

test('switching back to rewrite restores short expansion after overwrite', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'overwrite', persona_park: true })
    assert.equal(applyFromSettings(file).system[1].text, CRS_OFFICIAL_AGENT_PROMPT)
    persistSettings(file, { persona_inject: 'rewrite' })
    const back = applyFromSettings(file)
    assert.equal(back.system[1].text, CRS_AGENT_EXPANSION)
    assert.deepEqual(back.system[1].cache_control, AGENT_EXPANSION_CACHE_CONTROL)
    assert.ok(!envText(back).includes('You have been invoked'))
  })
})

test('persona_agent does not change zero and defaults still select legacy rewrite', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'rewrite', persona_agent: 'rewrite' })
    assert.equal(applyFromSettings(file).system[1].text, CRS_AGENT_EXPANSION)
    for (const agent of ['default', 'rewrite', 'minimal', 'required']) {
      persistSettings(file, { persona_inject: 'zero', persona_agent: agent })
      const out = applyFromSettings(file)
      assert.equal(out.system.length, 1, agent)
      assert.match(out.system[0].text, /prompt_version=</)
      assert.equal(firstUser(out), UNOFFICIAL.messages[0].content)
    }
  })
})

test('persona_expansion never drops agent+env; official_tools restores 4 blocks', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'rewrite', persona_expansion: 'never' })
    const two = applyFromSettings(file)
    assert.equal(two.system.length, 2)
    assert.equal(two.system[1].text, CRS_OFFICIAL_SYSTEM)
    assert.ok(!two.system.some((b) => b?.text === CRS_AGENT_EXPANSION))

    persistSettings(file, { persona_expansion: 'official_tools' })
    const four = applyFromSettings(file)
    assert.equal(four.system.length, 4)
    assert.equal(four.system[1].text, CRS_AGENT_EXPANSION)
  })
})

test('persona_park checkbox writes and is hot-read', () => {
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'rewrite', persona_park: false })
    const off = applyFromSettings(file)
    assert.equal(firstUser(off), UNOFFICIAL.messages[0].content)
    persistSettings(file, { persona_park: true })
    assert.match(firstUser(applyFromSettings(file)), /MANDATORY constraints for this turn/)
  })
})

test('official Claude Code inbound is unchanged for every settings radio', () => {
  const official = {
    system: [
      {
        type: 'text',
        text: `x-anthropic-billing-header: cc_version=2.1.241.abc; cc_entrypoint=cli;\n${CRS_OFFICIAL_SYSTEM}`,
      },
    ],
    messages: [{ role: 'user', content: 'hi' }],
    metadata: { user_id: JSON.stringify({ device_id: 'd', account_uuid: 'a', session_id: 's' }) },
  }
  const headers = { 'user-agent': 'claude-cli/2.1.241 (external, cli)' }
  withRouting((file) => {
    for (const radio of SETTINGS_RADIOS) {
      persistSettings(file, { persona_inject: radio })
      const out = applyCrsUnofficialPersona(official, { routingFile: file, headers })
      assert.equal(out.system[0].text, official.system[0].text)
      assert.equal(out.system.length, 1)
    }
  })
})

test('console aliases that radios never send: append stays backend append, not rewrite', () => {
  assert.equal(normalizePersonaMode('append'), 'append')
  assert.equal(normalizePersonaMode('add'), 'append')
  assert.equal(normalizePersonaMode('attach'), 'append')
  withRouting((file) => {
    persistSettings(file, { persona_inject: 'append' })
    const out = applyFromSettings(file)
    const sys = out.system
    const text = typeof sys === 'string' ? sys : Array.isArray(sys) ? sys.map((b) => b?.text || '').join('\n') : ''
    assert.ok(text.includes(CRS_OFFICIAL_SYSTEM))
    assert.ok(!Array.isArray(sys) || sys[2]?.text !== CRS_AGENT_EXPANSION)
  })
})

test('zero agent aliases match settings radio values', () => {
  assert.equal(normalizePersonaAgent('default'), 'default')
  assert.equal(normalizePersonaAgent('rewrite'), 'rewrite')
  assert.equal(normalizePersonaAgent('overwrite'), 'rewrite')
  assert.equal(normalizePersonaAgent('minimal'), 'minimal')
  assert.equal(normalizePersonaAgent('required'), 'required')
})

test('official_prompt applies standing to its harness and keeps caller text in a reminder', () => {
  withRouting((file) => {
    persistSettings(file, {
      persona_inject: 'official_prompt',
      persona_park: true,
      agent_standing_presets: { official: true },
    })
    const out = applyFromSettings(file, { ...UNOFFICIAL, system: '你是一个高速收费员。' })
    assert.equal(out.system.length, 4)
    assert.ok(out.system[2].text.startsWith(DEFAULT_AGENT_STANDING + '\n\nYou are an agent working with the user'))
    assert.deepEqual(out.system[2].cache_control, { type: 'ephemeral', scope: 'global' })
    assert.ok(firstUser(out).includes('你是一个高速收费员。'))
    assert.match(firstUser(out), /MANDATORY constraints/)
    assert.ok(out.system.every((b) => !b.text.includes('你是一个高速收费员。')))
  })
})
