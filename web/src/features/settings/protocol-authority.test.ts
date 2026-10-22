import { describe, expect, it, vi } from 'vitest'
import type { VmPatch } from '@/lib/api'
import { personaInjectFromPreset } from '@/lib/persona-template'
import {
  inheritProtocolOnSlots,
  protocolFixedDrift,
  protocolFixedFields,
  protocolInheritPatch,
  withProtocolFixedFields,
} from './protocol-authority'

describe('protocolInheritPatch', () => {
  it('returns null when the slot already inherits', () => {
    expect(
      protocolInheritPatch({
        id: 'vm-05',
        persona_preset: '',
        inference_engine: null,
      })
    ).toBeNull()
  })
  it('clears explicit persona so settings → 协议 wins', () => {
    expect(
      protocolInheritPatch({
        id: 'vm-10',
        persona_preset: 'official',
        inference_engine: 'rust',
      })
    ).toEqual({ persona_preset: '' })
  })

  it('does not strip a slot engine on protocol save', () => {
    expect(
      protocolInheritPatch({
        id: 'vm-10',
        persona_preset: '',
        inference_engine: 'go',
      })
    ).toBeNull()
  })

  it('does not inherit Claude engine onto GPT slots', () => {
    expect(
      protocolInheritPatch({
        id: 'vm-gpt',
        platform: 'openai',
        family: 'codex',
        inference_engine: 'rust',
      })
    ).toBeNull()
  })
})

describe('inheritProtocolOnSlots', () => {
  it('patches only slots that override the protocol page', async () => {
    const apply = vi.fn(async (_id: string, _body: VmPatch) => ({}) as const)
    const result = await inheritProtocolOnSlots(
      [
        { id: 'vm-05', persona_preset: 'official', inference_engine: 'rust' },
        { id: 'vm-13', persona_preset: '', inference_engine: null },
      ],
      apply
    )
    expect(result).toEqual({ changed: 1, errors: [] })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith('vm-05', {
      persona_preset: '',
    })
  })

  it('keeps going when one slot fails', async () => {
    const apply = vi.fn(async (id: string) => {
      if (id === 'vm-05') throw new Error('config_missing')
    })
    const result = await inheritProtocolOnSlots(
      [
        { id: 'vm-05', persona_preset: 'official' },
        { id: 'vm-06', persona_preset: 'zero' },
      ],
      apply
    )
    expect(result.changed).toBe(1)
    expect(result.errors).toEqual([{ id: 'vm-05', message: 'config_missing' }])
  })
})

describe('protocol fixed fields', () => {
  it('save writes exactly the listed values and keeps everything else', () => {
    const body = {
      compatibility: {
        persona_preset: 'official_303',
        overlay_preset: 'official',
        persona_park: true,
        cache_ttl: '5m',
        cache_breakpoints: {
          enabled: true,
          system_tail: true,
          messages: 'rewrite',
        },
      },
      inference: {
        engine: 'go',
        fallback_to_go: true,
        session_idle_ttl_seconds: 900,
      },
      sticky: { ttl_seconds: 30 },
    }
    const out = withProtocolFixedFields(body)
    expect(out).toEqual({
      compatibility: {
        persona_preset: 'official_303',
        overlay_preset: 'off',
        persona_park: false,
        cache_ttl: '5m',
        cache_breakpoints: {
          enabled: true,
          system_tail: false,
          tools_tail: false,
          messages: 'cli-hop',
        },
      },
      inference: {
        engine: 'rust',
        fallback_to_go: false,
        session_idle_ttl_seconds: 900,
      },
      sticky: { ttl_seconds: 30 },
    })
    expect(body.compatibility.overlay_preset).toBe('official')
    for (const field of protocolFixedFields(
      out.compatibility as Record<string, unknown>,
      out.inference as Record<string, unknown>
    )) {
      expect(field.stored).toEqual(field.saved)
    }
  })

  it('drift lists stored values the next save will change', () => {
    expect(
      protocolFixedDrift(
        {
          overlay_preset: 'off',
          persona_park: false,
          cache_breakpoints: {
            system_tail: false,
            tools_tail: false,
            messages: 'cli-hop',
          },
        },
        { engine: 'rust', fallback_to_go: false }
      )
    ).toEqual([])
    expect(
      protocolFixedDrift(
        { overlay_preset: 'official' },
        { engine: 'rust', fallback_to_go: false }
      ).map((field) => field.key)
    ).toEqual([
      'compatibility.overlay_preset',
      'compatibility.persona_park',
      'compatibility.cache_breakpoints.system_tail',
      'compatibility.cache_breakpoints.tools_tail',
      'compatibility.cache_breakpoints.messages',
    ])
  })

  it('official_303 keeps the official_full legacy inject', () => {
    expect(personaInjectFromPreset('official_303', 'rewrite')).toBe(
      'official_full'
    )
  })
})
