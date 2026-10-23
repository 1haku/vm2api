import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOutboundProfile } from '../../src/lib/admin/outbound-profile.mjs'
import { validatePersonaRoutingPatch } from '../../src/lib/admin/panel-api.mjs'
import { personaPreviewVars } from '../../src/lib/identity/crs-persona.mjs'

test('global official_303 reference: 2.1.303 profile, model shapes and panel values', () => {
  const profile = buildOutboundProfile({
    routing: {
      compatibility: {
        persona_preset: 'official_303',
        cache_ttl: '5m',
        cch_enabled: false,
        thinking_display: 'passthrough',
      },
    },
  })
  assert.equal(profile.scope, 'global')
  assert.deepEqual(profile.preset, { value: 'official_303', source: 'panel' })
  assert.equal(profile.profile.version, '2.1.303')
  assert.equal(profile.user_agent.value, 'claude-cli/2.1.303 (external, sdk-cli)')
  assert.equal(profile.billing.cc_version, '2.1.303.<fingerprint>')
  assert.deepEqual(
    profile.shapes.map((row) => row.shape),
    ['lean', 'full'],
  )
  assert.equal(profile.shapes[0].rules.markers, 3)
  assert.equal(profile.top_level_order[0], 'model')
  assert.deepEqual(profile.cache_ttl, { value: '5m', source: 'panel' })
  assert.equal(profile.cch_enabled.value, false)
  assert.equal(profile.thinking_display.value, 'passthrough')
  assert.match(profile.anthropic_beta.value, /oauth-2025-04-20/)
})

test('slot reference: override source, inherited 296 preset, no credential material', () => {
  const vm = {
    id: 'vm-07',
    persona_preset: 'official_303',
    timezone: 'Asia/Tokyo',
    claude: { mode: 'api-key', api_key: 'fixture-SECRET-key' },
  }
  const routing = { compatibility: { persona_preset: 'official_full' } }
  const slot = buildOutboundProfile({ routing, vm })
  assert.equal(slot.scope, 'vm')
  assert.deepEqual(slot.preset, { value: 'official_303', source: 'vm' })
  assert.equal(slot.profile.version, '2.1.303')
  assert.equal(slot.timezone.value, 'Asia/Tokyo')
  assert.doesNotMatch(slot.anthropic_beta.value, /oauth-2025-04-20/)
  assert.equal(JSON.stringify(slot).includes('SECRET'), false)
  const inherited = buildOutboundProfile({ routing, vm: { id: 'vm-08' } })
  assert.deepEqual(inherited.preset, { value: 'official_full', source: 'panel' })
  assert.equal(inherited.profile.version, '2.1.296')
  assert.equal(inherited.profile.descriptive, true)
  assert.equal(inherited.shapes, null)
})

test('routing PUT accepts official_303 for the preset, templates and per-preset switches', () => {
  assert.deepEqual(
    validatePersonaRoutingPatch({
      compatibility: {
        persona_preset: 'official_303',
        persona_env_presets: { official_303: true },
        agent_standing_presets: { official_303: false },
        persona_templates: {
          official_303: [{ id: 'main', type: 'text', text: '{{agent_standing}}{{main_prompt_303}}' }],
        },
      },
    }),
    [],
  )
  assert.notDeepEqual(validatePersonaRoutingPatch({ compatibility: { persona_preset: 'official_304' } }), [])
})

test('preview vars carry the 2.1.303 main prompt and Environment', () => {
  const vars = personaPreviewVars({ timezone: 'UTC', model: 'claude-opus-5-5' })
  assert.match(vars.main_prompt_303, /^\nYou are an agent working with the user/)
  assert.match(vars.env_303, /^# Environment\nYou have been invoked in the following environment: /)
})
