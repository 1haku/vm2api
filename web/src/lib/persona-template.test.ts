import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_STANDING,
  DEFAULT_PERSONA_TEMPLATES,
  EMPTY_BLOCK_TEXT,
  PERSONA_PRESET_OPTIONS,
  PERSONA_PRESETS,
  agentStandingVar,
  overlayDisabledByPersona,
  personaInjectFromPreset,
  protocolPersonaSaveToast,
  presetSeed,
  personaHideEnabled,
  previewSystemBlocks,
  setPersonaHide,
  setPresetFlag,
  templateSlotState,
  templateOrFollowPreset,
  validatePersonaTemplate,
} from './persona-template'

describe('persona template contract', () => {
  it('keeps the four routing presets in PUT order', () => {
    expect([...PERSONA_PRESETS]).toEqual([
      'official',
      'official_full',
      'zero',
      'custom',
    ])
    expect(PERSONA_PRESET_OPTIONS.map(([value]) => value)).toEqual([
      ...PERSONA_PRESETS,
    ])
  })

  it('keeps official / official_full / zero slot ids and hide defaults', () => {
    expect(DEFAULT_PERSONA_TEMPLATES.official.map((block) => block.id)).toEqual(
      ['billing', 'identity', 'caller_agent', 'env', 'caller_system']
    )
    expect(
      DEFAULT_PERSONA_TEMPLATES.official_full.map((block) => block.id)
    ).toEqual([
      'billing',
      'identity',
      'agent_official',
      'env_official',
      'caller_system',
    ])
    expect(DEFAULT_PERSONA_TEMPLATES.official_full[2]?.text).toBe(
      '{{agent_standing}}{{agent_official}}'
    )
    expect(DEFAULT_PERSONA_TEMPLATES.zero.map((block) => block.id)).toEqual([
      'billing_zero',
      'identity_slot',
      'agent_slot',
      'env',
      'caller_system',
    ])
    expect(DEFAULT_PERSONA_TEMPLATES.official.some((block) => block.hide)).toBe(
      false
    )
    expect(
      DEFAULT_PERSONA_TEMPLATES.official_full.some((block) => block.hide)
    ).toBe(false)
    expect(
      DEFAULT_PERSONA_TEMPLATES.zero.map((block) => block.hide === true)
    ).toEqual([true, true, true, true, false])
    expect(DEFAULT_PERSONA_TEMPLATES.zero[2]?.text).toBe(
      '{{agent_standing}}{{caller_agent}}'
    )
    expect(DEFAULT_PERSONA_TEMPLATES.zero[2]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    })
    expect(DEFAULT_PERSONA_TEMPLATES.zero[2]?.note).toBeUndefined()
    expect(DEFAULT_PERSONA_TEMPLATES.custom).toEqual([])
  })

  it('forces overlay off only for zero, and empty custom seeds official', () => {
    expect(overlayDisabledByPersona('zero')).toBe(true)
    expect(overlayDisabledByPersona('official')).toBe(false)
    expect(presetSeed(DEFAULT_PERSONA_TEMPLATES, 'custom')).toEqual(
      DEFAULT_PERSONA_TEMPLATES.official
    )
    expect(
      templateOrFollowPreset(
        DEFAULT_PERSONA_TEMPLATES.zero,
        DEFAULT_PERSONA_TEMPLATES,
        'zero'
      )
    ).toEqual([])
    expect(validatePersonaTemplate(DEFAULT_PERSONA_TEMPLATES.zero)).toEqual([])
  })

  it('writes the three persona switches back as their own inject values', () => {
    expect(personaInjectFromPreset('official', 'rewrite')).toBe(
      'official_prompt'
    )
    expect(personaInjectFromPreset('official_full', 'rewrite')).toBe(
      'official_full'
    )
    expect(personaInjectFromPreset('zero', 'rewrite')).toBe('zero')
    expect(personaInjectFromPreset('custom', 'append')).toBe('append')
  })

  it('save toast names the stored preset and the kernel hot update', () => {
    expect(
      protocolPersonaSaveToast({ persona_preset: 'official_full' }, 0, {
        updated: 2,
      })
    ).toBe('已保存 · 官方完整提示词 · system 提示词已热更新 2 个槽')
    expect(
      protocolPersonaSaveToast({ persona_preset: 'zero' }, 1, { updated: 0 })
    ).toBe(
      '已保存 · 0注入 · 1 个槽位改为跟随全局 · system 提示词的 kernel 配置已一致'
    )
  })
})

describe('agent standing + system preview', () => {
  const vars = {
    identity: 'ID',
    agent_official: 'AGENT',
    env_official: 'ENV',
    caller_agent: '',
    caller_system: '',
  }

  it('defaults on for every preset; explicit empty string removes it', () => {
    for (const key of PERSONA_PRESETS) {
      expect(agentStandingVar({}, key)).toBe(`${DEFAULT_AGENT_STANDING}\n`)
    }
    expect(agentStandingVar({ agent_standing: '' }, 'official')).toBe('')
    expect(
      agentStandingVar({ agent_standing_presets: { zero: false } }, 'zero')
    ).toBe('')
  })

  it('drops billing blocks and keeps a blank zero agent slot as zero-width', () => {
    const zero = previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.zero, {
      ...vars,
      agent_standing: '',
    })
    expect(zero.map((block) => block.id)).toEqual([
      'identity_slot',
      'agent_slot',
    ])
    expect(zero[1]?.text).toBe(EMPTY_BLOCK_TEXT)
    expect(zero[1]?.placeholder).toBe(true)

    const official = previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.official, {
      ...vars,
      agent_standing: agentStandingVar({}, 'official'),
      env: '# Environment\n - Timezone: Asia/Tokyo',
    })
    expect(official.map((block) => block.text)).toEqual([
      'ID',
      `${DEFAULT_AGENT_STANDING}\n`,
      '# Environment\n - Timezone: Asia/Tokyo',
    ])
  })

  it('reports whether a template can switch standing / env', () => {
    const full = DEFAULT_PERSONA_TEMPLATES.official_full
    expect(templateSlotState(full, 'agent_standing')).toBe('switch')
    expect(templateSlotState(full, 'env', ['env_official'])).toBe('builtin')
    expect(
      templateSlotState(DEFAULT_PERSONA_TEMPLATES.zero, 'env', ['env_official'])
    ).toBe('switch')
    expect(templateSlotState([], 'env', ['env_official'])).toBe('absent')
    expect(templateSlotState(DEFAULT_PERSONA_TEMPLATES.official, 'env')).toBe(
      'switch'
    )
  })

  it('toggle map is only written once it differs from the all-on default', () => {
    const off = setPresetFlag({}, 'persona_env_presets', 'zero', false, {})
    expect(off.persona_env_presets).toEqual({
      official: true,
      official_full: true,
      zero: false,
      custom: true,
    })
    const back = setPresetFlag(off, 'persona_env_presets', 'zero', true, {})
    expect('persona_env_presets' in back).toBe(false)
    const serverHad = setPresetFlag(off, 'persona_env_presets', 'zero', true, {
      persona_env_presets: { zero: false },
    })
    expect(serverHad.persona_env_presets).toMatchObject({ zero: true })
  })

  it('whole-preset mask: map beats legacy persona_hides beats template hide', () => {
    const zero = DEFAULT_PERSONA_TEMPLATES.zero
    const official = DEFAULT_PERSONA_TEMPLATES.official
    expect(personaHideEnabled({}, 'zero', zero)).toBe(true)
    expect(personaHideEnabled({}, 'official', official)).toBe(false)
    expect(
      personaHideEnabled({ persona_hides: true }, 'official', official)
    ).toBe(true)
    expect(
      personaHideEnabled(
        { persona_hides: true, persona_hide_presets: { official: false } },
        'official',
        official
      )
    ).toBe(false)
    const off = setPersonaHide({}, 'zero', false, zero, {})
    expect(off.persona_hide_presets).toEqual({ zero: false })
    expect(
      'persona_hide_presets' in setPersonaHide(off, 'zero', true, zero, {})
    ).toBe(false)
  })
})
