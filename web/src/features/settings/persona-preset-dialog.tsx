import type { PersonaPreset } from '@/types/panel-routing'
import {
  DEFAULT_PERSONA_TEMPLATES,
  parsePersonaTemplateLines,
  personaPresetLabel,
  presetSeed,
  renderPersonaTemplate,
  stringifyPersonaTemplate,
  PREVIEW_VARS,
  type RawBlock,
} from '@/lib/persona-template'
import {
  applyZeroFields,
  hiddenUsageBlocks,
  zeroFieldsFromBlocks,
} from '@/lib/persona-zero-fields'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { personaDraftStoresEmpty } from '@/features/settings/persona-drafts'
import {
  Notice,
  PersonaTemplateEditor,
} from '@/features/settings/persona-editors'

function previewSnippet(text: string, max = 96): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return '空'
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…`
}

function OutboundPreview({ blocks }: { blocks: RawBlock[] }) {
  const outbound = renderPersonaTemplate(blocks, PREVIEW_VARS)
  const hidden = hiddenUsageBlocks(blocks)
  return (
    <div className='space-y-2'>
      <p className='text-[11px] font-medium tracking-wide text-muted-foreground uppercase'>
        出站
      </p>
      {outbound.length ? (
        <ol className='space-y-1.5'>
          {outbound.map((block, i) => {
            const cc = block.cache_control
            const ttl = cc && typeof cc.ttl === 'string' ? cc.ttl : ''
            return (
              <li
                key={`${i}-${block.text.slice(0, 24)}`}
                className='rounded-md border border-border/60 bg-muted/20 px-2.5 py-2'
              >
                <div className='mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground'>
                  <span className='font-mono'>{i + 1}</span>
                  {ttl ? (
                    <span className='rounded bg-muted px-1 py-px font-mono'>
                      {ttl}
                    </span>
                  ) : null}
                </div>
                <p className='font-mono text-[11px] leading-relaxed'>
                  {previewSnippet(block.text)}
                </p>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className='text-xs text-muted-foreground'>无块</p>
      )}
      {hidden.length ? (
        <p className='font-mono text-[10px] text-muted-foreground'>
          遮罩 {hidden.map((block) => block.id || '·').join(' / ')}
        </p>
      ) : null}
    </div>
  )
}

function ZeroFieldsForm({
  blocks,
  onChange,
}: {
  blocks: RawBlock[]
  onChange: (blocks: RawBlock[]) => void
}) {
  const fields = zeroFieldsFromBlocks(blocks)
  return (
    <div className='space-y-2'>
      <div className='flex items-baseline justify-between gap-2'>
        <label htmlFor='zero-standing' className='text-sm font-medium'>
          常驻约束
        </label>
        <span className='font-mono text-[10px] text-muted-foreground'>
          caller_agent 前
        </span>
      </div>
      <Textarea
        id='zero-standing'
        className='min-h-36 font-mono text-xs'
        spellCheck={false}
        aria-label='0注入常驻约束'
        value={fields.standingText}
        onChange={(e) =>
          onChange(applyZeroFields(blocks, { standingText: e.target.value }))
        }
      />
    </div>
  )
}

export function PersonaPresetDialog({
  preset,
  open,
  text,
  onOpenChange,
  onTextChange,
}: {
  preset: PersonaPreset
  open: boolean
  text: string
  onOpenChange: (open: boolean) => void
  onTextChange: (text: string) => void
}) {
  const parsed = parsePersonaTemplateLines(text)
  const hasErrors = parsed.errors.length > 0
  const customEmpty =
    preset === 'custom' && personaDraftStoresEmpty(text, 'custom')
  const effective = parsed.blocks.length
    ? parsed.blocks
    : presetSeed(DEFAULT_PERSONA_TEMPLATES, preset)
  const isZero = preset === 'zero' && !hasErrors

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl'>
        <DialogHeader className='space-y-0 border-b px-5 py-3'>
          <DialogTitle>{personaPresetLabel(preset)}</DialogTitle>
          <DialogDescription className='sr-only'>
            配置{personaPresetLabel(preset)}
          </DialogDescription>
        </DialogHeader>

        <div className='min-h-0 flex-1 overflow-y-auto px-5 py-4'>
          {customEmpty ? (
            <Notice tone='caution'>空模板会回落官方提示词。</Notice>
          ) : null}

          <div className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_16rem]'>
            <div className='space-y-3'>
              {isZero ? (
                <ZeroFieldsForm
                  blocks={parsed.blocks.length ? parsed.blocks : effective}
                  onChange={(blocks) =>
                    onTextChange(stringifyPersonaTemplate(blocks))
                  }
                />
              ) : (
                <PersonaTemplateEditor
                  text={text}
                  blocks={parsed.blocks}
                  hasErrors={hasErrors}
                  customEmpty={false}
                  onTextChange={onTextChange}
                  onBlocksChange={(blocks) =>
                    onTextChange(stringifyPersonaTemplate(blocks))
                  }
                  onReset={() =>
                    onTextChange(
                      stringifyPersonaTemplate(
                        presetSeed(DEFAULT_PERSONA_TEMPLATES, preset)
                      )
                    )
                  }
                />
              )}

              {isZero ? (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button
                      type='button'
                      size='sm'
                      variant='ghost'
                      className='cursor-pointer'
                    >
                      JSONL
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className='pt-2'>
                    <Textarea
                      className='h-32 font-mono text-xs'
                      spellCheck={false}
                      aria-label='0注入 system 模板 JSONL'
                      value={text}
                      onChange={(e) => onTextChange(e.target.value)}
                    />
                    <div className='mt-2 flex justify-end'>
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        className='cursor-pointer'
                        onClick={() =>
                          onTextChange(
                            stringifyPersonaTemplate(
                              presetSeed(DEFAULT_PERSONA_TEMPLATES, 'zero')
                            )
                          )
                        }
                      >
                        恢复预设
                      </Button>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </div>

            <aside className='lg:border-l lg:border-border/60 lg:pl-4'>
              {hasErrors ? (
                <Notice tone='bad'>JSONL 有错，先修好再预览。</Notice>
              ) : (
                <OutboundPreview blocks={effective} />
              )}
            </aside>
          </div>
        </div>

        <DialogFooter className='border-t px-5 py-3'>
          <Button
            type='button'
            variant='outline'
            className='cursor-pointer'
            onClick={() => onOpenChange(false)}
          >
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
