import { useEffect, useMemo, useState } from 'react'
import type { PersonaPreset } from '@/types/panel-routing'
import {
  PERSONA_PRESET_OPTIONS,
  PERSONA_PRESETS,
  formatLineError,
  parsePersonaTemplateLines,
  personaPresetFromCompat,
  personaPresetLabel,
  validatePersonaTemplate,
} from '@/lib/persona-template'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  type PersonaDrafts,
  personaSchemeSummary,
  personaTemplatesPayload,
  seedPersonaDrafts,
} from '@/features/settings/persona-drafts'
import { Problems } from '@/features/settings/persona-editors'
import { PersonaPresetDialog } from '@/features/settings/persona-preset-dialog'

type Compat = Record<string, unknown>

export function PersonaPane({
  compat,
  onChange,
  onProblemsChange,
}: {
  compat: Compat
  onChange: (next: Compat) => void
  onProblemsChange?: (problems: string[]) => void
}) {
  const [personaDrafts, setPersonaDrafts] = useState<PersonaDrafts | null>(null)
  const [dialogPreset, setDialogPreset] = useState<PersonaPreset | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  useEffect(() => {
    if (personaDrafts || !Object.keys(compat).length) return
    setPersonaDrafts(seedPersonaDrafts(compat))
  }, [compat, personaDrafts])

  const preset = personaPresetFromCompat(compat)

  const problems = useMemo(() => {
    if (!personaDrafts) return []
    const out: string[] = []
    const label = (key: string, active: boolean) => (active ? '' : `「${key}」`)
    for (const key of PERSONA_PRESETS) {
      const parsed = parsePersonaTemplateLines(personaDrafts[key])
      const at = label(personaPresetLabel(key), key === preset)
      for (const err of parsed.errors)
        out.push(`模板${at}${formatLineError(err)}`)
      for (const msg of validatePersonaTemplate(parsed.blocks))
        out.push(`模板${at}${msg}`)
    }
    return out
  }, [personaDrafts, preset])

  useEffect(() => {
    onProblemsChange?.(problems)
  }, [problems, onProblemsChange])

  const commit = (
    nextPersona: PersonaDrafts,
    patch: Record<string, unknown> = {}
  ) => {
    onChange({
      ...compat,
      ...patch,
      persona_templates: personaTemplatesPayload(nextPersona),
    })
  }

  const setPersonaDraft = (key: PersonaPreset, text: string) => {
    if (!personaDrafts) return
    const next = { ...personaDrafts, [key]: text }
    setPersonaDrafts(next)
    commit(next)
  }

  const openScheme = (key: PersonaPreset) => {
    setDialogPreset(key)
    setDialogOpen(true)
  }

  const selectPreset = (next: PersonaPreset) => {
    if (!personaDrafts) return
    commit(personaDrafts, { persona_preset: next })
    if (next === 'zero') openScheme('zero')
  }

  const editing = dialogPreset ?? 'official'

  if (!personaDrafts) {
    return <p className='text-sm text-muted-foreground'>读取中…</p>
  }

  return (
    <div className='space-y-3'>
      <RadioGroup
        value={preset}
        onValueChange={(v) => selectPreset(v as PersonaPreset)}
        className='grid gap-2 sm:grid-cols-2'
        name='persona-preset'
      >
        {PERSONA_PRESET_OPTIONS.map(([key, label]) => {
          const active = key === preset
          return (
            <div
              key={key}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 px-3 py-3 transition-colors duration-200',
                active
                  ? 'border-primary/40 bg-muted/40'
                  : 'hover:border-border hover:bg-muted/20'
              )}
            >
              <RadioGroupItem
                id={`persona-preset-${key}`}
                value={key}
                className='mt-1'
              />
              <div className='min-w-0 flex-1 space-y-1.5'>
                <div className='flex items-center justify-between gap-2'>
                  <Label
                    htmlFor={`persona-preset-${key}`}
                    className='cursor-pointer text-sm font-medium'
                  >
                    {label}
                  </Label>
                  {active ? (
                    <span className='text-[10px] tracking-wide text-emerald-500 uppercase'>
                      启用
                    </span>
                  ) : null}
                </div>
                <p className='text-[11px] text-muted-foreground'>
                  {personaSchemeSummary(personaDrafts[key], key)}
                </p>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='cursor-pointer'
                  aria-label={`配置${label}`}
                  onClick={() => openScheme(key)}
                >
                  配置
                </Button>
              </div>
            </div>
          )
        })}
      </RadioGroup>

      <Problems items={problems} />

      <PersonaPresetDialog
        preset={editing}
        open={dialogOpen}
        text={personaDrafts[editing]}
        onOpenChange={setDialogOpen}
        onTextChange={(text) => setPersonaDraft(editing, text)}
      />
    </div>
  )
}
