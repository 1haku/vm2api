import { PERSONA_TEMPLATE_VARS, type RawBlock } from '@/lib/persona-template'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

export function RadioRow<T extends string>({
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  name: string
  value: T
  options: [T, string][]
  disabled?: boolean
  onChange: (v: T) => void
}) {
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as T)}
      disabled={disabled}
      className='flex flex-wrap gap-x-5 gap-y-2'
    >
      {options.map(([v, label]) => (
        <div key={v} className='flex items-center gap-2'>
          <RadioGroupItem id={`${name}-${v}`} value={v} />
          <Label htmlFor={`${name}-${v}`} className='text-sm font-normal'>
            {label}
          </Label>
        </div>
      ))}
    </RadioGroup>
  )
}

export function VarsHint({ vars }: { vars: [string, string][] }) {
  return (
    <div className='flex flex-wrap gap-1'>
      {vars.map(([name]) => (
        <code
          key={name}
          className='rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground'
        >
          {`{{${name}}}`}
        </code>
      ))}
    </div>
  )
}

/** 块含义表：flex 行，不用 <table>（component-guidelines）。 */
export function BlockNotes({ blocks }: { blocks: RawBlock[] }) {
  if (!blocks.length) {
    return (
      <p className='text-xs text-muted-foreground'>
        模板为空，出站会回落内置预设。
      </p>
    )
  }
  return (
    <div className='rounded-md border border-border/60'>
      <div className='flex h-7 items-center border-b border-border/60 bg-muted/30 px-3 text-[11px] font-medium text-muted-foreground/80'>
        <div className='min-w-[100px] flex-1'>块</div>
        <div className='min-w-[180px] flex-[3] px-1.5'>含义</div>
        <div className='min-w-[120px] flex-1 px-1.5'>行为</div>
      </div>
      {blocks.map((block, i) => (
        <div
          key={`${String(block.id ?? '')}-${i}`}
          className='flex items-center border-b border-border/40 px-3 py-1.5 text-xs last:border-b-0'
        >
          <div className='min-w-[100px] flex-1 truncate font-mono'>
            {String(block.id ?? '-')}
          </div>
          <div className='min-w-[180px] flex-[3] px-1.5 text-muted-foreground'>
            {String(block.note ?? '')}
          </div>
          <div className='min-w-[120px] flex-1 px-1.5 text-muted-foreground'>
            {block.hide ? '遮罩' : '—'} ·{' '}
            {block.drop_if_empty ? '空则丢弃' : '必写'}
            {cacheControlLabel(block)}
          </div>
        </div>
      ))}
    </div>
  )
}

function cacheRecord(block: RawBlock): Record<string, unknown> | null {
  const cc = block.cache_control
  if (!cc || typeof cc !== 'object' || Array.isArray(cc)) return null
  return cc as Record<string, unknown>
}

function cacheControlLabel(block: RawBlock): string {
  const cc = cacheRecord(block)
  if (!cc) return ''
  const ttl = typeof cc.ttl === 'string' ? cc.ttl : ''
  const scope = typeof cc.scope === 'string' ? cc.scope : ''
  if (!ttl && !scope) return ''
  return ` · 缓存 ${[ttl, scope].filter(Boolean).join(' ')}`
}

function cacheControlOf(block: RawBlock): {
  ttl: string
  scope: string
} {
  const cc = cacheRecord(block)
  if (!cc) return { ttl: '', scope: '' }
  return {
    ttl: typeof cc.ttl === 'string' ? cc.ttl : '',
    scope: typeof cc.scope === 'string' ? cc.scope : '',
  }
}

function withCacheControl(
  block: RawBlock,
  ttl: string,
  scope: string
): RawBlock {
  const next = { ...block }
  const prev = block.cache_control
  const cc: Record<string, unknown> =
    prev && typeof prev === 'object' && !Array.isArray(prev) ? { ...prev } : {}
  if (ttl.trim()) {
    if (cc.type == null) cc.type = 'ephemeral'
    cc.ttl = ttl.trim()
  } else {
    delete cc.ttl
  }
  if (scope.trim()) cc.scope = scope.trim()
  else delete cc.scope
  if (Object.keys(cc).length === 0) delete next.cache_control
  else next.cache_control = cc
  return next
}

function PersonaBlockCard({
  block,
  index,
  onChange,
  onRemove,
}: {
  block: RawBlock
  index: number
  onChange: (block: RawBlock) => void
  onRemove: () => void
}) {
  const cache = cacheControlOf(block)
  return (
    <div className='space-y-2 rounded-lg border border-border/60 bg-card p-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <Input
          className='h-7 w-28 font-mono text-xs'
          value={String(block.id ?? '')}
          placeholder='id'
          aria-label={`第 ${index + 1} 块 id`}
          onChange={(e) => onChange({ ...block, id: e.target.value })}
        />
        <label className='flex items-center gap-1.5 text-[11px] text-muted-foreground'>
          <Switch
            checked={block.hide === true}
            onCheckedChange={(on) => {
              const next = { ...block }
              if (on) next.hide = true
              else delete next.hide
              onChange(next)
            }}
          />
          遮罩
        </label>
        <label className='flex items-center gap-1.5 text-[11px] text-muted-foreground'>
          <Switch
            checked={block.drop_if_empty === true}
            onCheckedChange={(on) => {
              const next = { ...block }
              if (on) next.drop_if_empty = true
              else delete next.drop_if_empty
              onChange(next)
            }}
          />
          空丢
        </label>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='ml-auto cursor-pointer'
          onClick={onRemove}
        >
          删
        </Button>
      </div>
      <Textarea
        className='min-h-20 font-mono text-xs'
        value={typeof block.text === 'string' ? block.text : ''}
        aria-label={`第 ${index + 1} 块内容`}
        onChange={(e) => onChange({ ...block, text: e.target.value })}
      />
      <div className='flex items-center gap-2'>
        <Input
          className='h-7 w-16 font-mono text-xs'
          value={cache.ttl}
          placeholder='ttl'
          aria-label={`第 ${index + 1} 块 cache ttl`}
          onChange={(e) =>
            onChange(withCacheControl(block, e.target.value, cache.scope))
          }
        />
        <Input
          className='h-7 w-20 font-mono text-xs'
          value={cache.scope}
          placeholder='scope'
          aria-label={`第 ${index + 1} 块 cache scope`}
          onChange={(e) =>
            onChange(withCacheControl(block, cache.ttl, e.target.value))
          }
        />
      </div>
    </div>
  )
}

export function PersonaBlockFields({
  blocks,
  onChange,
}: {
  blocks: RawBlock[]
  onChange: (blocks: RawBlock[]) => void
}) {
  if (!blocks.length) {
    return (
      <div className='space-y-2'>
        <p className='text-xs text-muted-foreground'>空 · 回落官方</p>
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='cursor-pointer'
          onClick={() => onChange([{ id: 'block_1', type: 'text', text: '' }])}
        >
          加一块
        </Button>
      </div>
    )
  }
  return (
    <div className='space-y-2'>
      {blocks.map((block, index) => (
        <PersonaBlockCard
          key={`${String(block.id ?? '')}-${index}`}
          block={block}
          index={index}
          onChange={(next) =>
            onChange(blocks.map((item, i) => (i === index ? next : item)))
          }
          onRemove={() => onChange(blocks.filter((_, i) => i !== index))}
        />
      ))}
      <Button
        type='button'
        size='sm'
        variant='outline'
        className='cursor-pointer'
        onClick={() =>
          onChange([
            ...blocks,
            {
              id: `block_${blocks.length + 1}`,
              type: 'text',
              text: '',
            },
          ])
        }
      >
        加一块
      </Button>
    </div>
  )
}

export function PersonaTemplateEditor({
  text,
  blocks,
  hasErrors,
  customEmpty,
  onTextChange,
  onBlocksChange,
  onReset,
}: {
  text: string
  blocks: RawBlock[]
  hasErrors: boolean
  customEmpty: boolean
  onTextChange: (text: string) => void
  onBlocksChange: (blocks: RawBlock[]) => void
  onReset: () => void
}) {
  const jsonl = (
    <Textarea
      className='h-32 font-mono text-xs'
      spellCheck={false}
      aria-label='system 模板 JSONL'
      value={text}
      onChange={(e) => onTextChange(e.target.value)}
    />
  )
  return (
    <>
      <div className='flex items-center justify-end'>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='cursor-pointer'
          onClick={onReset}
        >
          恢复预设
        </Button>
      </div>
      {hasErrors ? (
        jsonl
      ) : (
        <PersonaBlockFields blocks={blocks} onChange={onBlocksChange} />
      )}
      {customEmpty ? (
        <Notice tone='caution'>空模板会回落官方提示词。</Notice>
      ) : null}
      {hasErrors ? null : (
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
          <CollapsibleContent className='space-y-2 pt-2'>
            {jsonl}
            <VarsHint vars={PERSONA_TEMPLATE_VARS} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  )
}

export function Problems({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <ul
      className='space-y-1 rounded-md border px-3 py-2 text-xs'
      style={{
        color: 'var(--status-bad)',
        backgroundColor: 'var(--status-bad-bg)',
        borderColor: 'var(--status-bad)',
      }}
    >
      {items.map((msg, i) => (
        <li key={`${i}-${msg}`}>{msg}</li>
      ))}
    </ul>
  )
}

export function Notice({
  tone,
  children,
}: {
  tone: 'caution' | 'bad'
  children: React.ReactNode
}) {
  return (
    <p
      className='rounded-md border px-3 py-2 text-xs leading-relaxed'
      style={{
        color: `var(--status-${tone})`,
        backgroundColor: `var(--status-${tone}-bg)`,
        borderColor: `var(--status-${tone})`,
      }}
    >
      {children}
    </p>
  )
}
