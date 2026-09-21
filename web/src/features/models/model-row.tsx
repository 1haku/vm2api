import type { ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  type ModelEntry,
  type ModelParams,
  type ModelPolicy,
  type Pass1mMode,
  contextWindowLabel,
  passContext1mEffective,
  passContext1mMode,
  thinkingPolicyLabel,
} from './policy'

type Props = {
  model: ModelEntry
  live: boolean
  pol: ModelPolicy
  open: boolean
  showBeta?: boolean
  onToggleOpen: () => void
  onToggleEnabled: (on: boolean) => void
  onParam: (key: keyof ModelParams, value: string | number) => void
  onPass1m: (mode: Pass1mMode) => void
}

export function ModelRow({
  model,
  live,
  pol,
  open,
  showBeta = true,
  onToggleOpen,
  onToggleEnabled,
  onParam,
  onPass1m,
}: Props) {
  const on = model.enabled !== false
  const win = contextWindowLabel(model)
  const caps = model.capabilities || {}
  const params = model.params || {}
  const defs = pol.defaults || {}
  const mode = passContext1mMode(model)
  const effective = passContext1mEffective(model, pol)
  const inheritHit = mode === 'inherit' && effective
  const drop = (model.betas?.drop || []).join(', ') || '—'
  const onEnabled =
    params.on_enabled === 'convert_to_adaptive'
      ? 'passthrough'
      : params.on_enabled || 'passthrough'
  const fallback =
    params.thinking_fallback_budget != null
      ? params.thinking_fallback_budget
      : defs.thinking_fallback_budget || 4096

  return (
    <div className={cn(!on && 'opacity-60')}>
      <div
        className='flex cursor-pointer items-center border-b border-border/50 text-sm transition-colors duration-200 hover:bg-muted/40'
        onClick={onToggleOpen}
      >
        <div
          className='flex w-14 shrink-0 items-center pl-3'
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={on}
            onCheckedChange={(v) => onToggleEnabled(v === true)}
            aria-label={`启用 ${model.display_name || model.id}`}
          />
        </div>
        <div className='min-w-[180px] flex-[1.6] px-1.5 py-2'>
          <div className='font-medium'>{model.display_name || model.id}</div>
          <div className='font-mono text-[11px] text-muted-foreground'>
            {model.id}
            {model.aliases?.length ? ` · ${model.aliases.join(', ')}` : ''}
          </div>
        </div>
        <div className='min-w-[70px] flex-[0.6] px-1.5 text-xs tabular-nums'>
          {win.text}
          {win.native1m ? (
            <span className='ml-1 text-muted-foreground'>原生</span>
          ) : null}
        </div>
        {showBeta ? (
          <div
            className='min-w-[140px] flex-[0.9] px-1.5'
            onClick={(e) => e.stopPropagation()}
          >
            <Select
              value={mode}
              onValueChange={(v) => {
                if (v === 'true' || v === 'false' || v === 'inherit')
                  onPass1m(v)
              }}
            >
              <SelectTrigger
                className={cn(
                  'h-8 w-[132px] text-xs',
                  inheritHit && 'text-primary'
                )}
                title={
                  inheritHit
                    ? '未设开关，命中回退通配'
                    : mode === 'true'
                      ? '矩阵指定透传'
                      : mode === 'false'
                        ? '矩阵指定剥离'
                        : '未设，走回退通配'
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='true'>透传</SelectItem>
                <SelectItem value='false'>剥离</SelectItem>
                <SelectItem value='inherit'>
                  {effective ? '通配 → 透传' : '通配 → 剥离'}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div
          className='min-w-[110px] flex-[0.9] px-1.5 text-xs'
          title={caps.thinking_mode || ''}
        >
          {thinkingPolicyLabel(model)}
        </div>
        <div className='min-w-[70px] flex-[0.6] px-1.5 text-xs'>
          {live ? (
            <span className='text-[color:var(--status-ok)]'>对外</span>
          ) : (
            <span className='text-muted-foreground'>隐藏</span>
          )}
        </div>
        <div className='w-10 shrink-0 pr-2 text-right'>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='size-8 cursor-pointer'
            aria-expanded={open}
            aria-label={open ? '收起' : '展开'}
            onClick={(e) => {
              e.stopPropagation()
              onToggleOpen()
            }}
          >
            {open ? (
              <ChevronUp className='size-4' />
            ) : (
              <ChevronDown className='size-4' />
            )}
          </Button>
        </div>
      </div>
      {open ? (
        <div className='space-y-3 border-b border-border/40 bg-muted/20 px-4 py-3 text-sm'>
          <p className='text-xs font-medium text-muted-foreground'>Thinking</p>
          <EditorRow label='adaptive'>
            <Select
              value={params.on_adaptive || 'passthrough'}
              onValueChange={(v) => onParam('on_adaptive', v)}
            >
              <SelectTrigger className='h-8 w-[220px]'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='passthrough'>透传</SelectItem>
                <SelectItem value='convert_to_enabled'>
                  转为 enabled + budget
                </SelectItem>
                <SelectItem value='strip'>剥离 thinking</SelectItem>
              </SelectContent>
            </Select>
          </EditorRow>
          <EditorRow label='enabled'>
            <Select
              value={onEnabled}
              onValueChange={(v) => onParam('on_enabled', v)}
            >
              <SelectTrigger className='h-8 w-[220px]'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='passthrough'>透传</SelectItem>
                <SelectItem value='strip'>剥离 thinking</SelectItem>
              </SelectContent>
            </Select>
          </EditorRow>
          <p className='text-xs text-muted-foreground'>
            OAuth 保留客户端的 enabled / adaptive，不再把 enabled 转成
            adaptive。
          </p>
          <EditorRow label='fallback'>
            <Input
              className='h-8 w-[140px]'
              type='number'
              value={fallback}
              onChange={(e) =>
                onParam('thinking_fallback_budget', Number(e.target.value) || 0)
              }
            />
          </EditorRow>
          <p className='text-xs font-medium text-muted-foreground'>上限</p>
          <EditorRow label='默认 max_tokens'>
            <Input
              className='h-8 w-[140px]'
              type='number'
              value={params.max_tokens_default ?? 8192}
              onChange={(e) =>
                onParam('max_tokens_default', Number(e.target.value) || 0)
              }
            />
          </EditorRow>
          <EditorRow label='max_tokens 上限'>
            <Input
              className='h-8 w-[140px]'
              type='number'
              value={params.max_tokens_cap ?? 64000}
              onChange={(e) =>
                onParam('max_tokens_cap', Number(e.target.value) || 0)
              }
            />
          </EditorRow>
          <p className='text-xs font-medium text-muted-foreground'>只读</p>
          <EditorRow label='窗口'>
            <span>
              {win.text}
              {win.native1m ? ' · 原生 1M（一般不要透传 beta）' : ''}
            </span>
          </EditorRow>
          <EditorRow label='Beta drop'>
            <span className='font-mono text-xs break-all'>{drop}</span>
          </EditorRow>
        </div>
      ) : null}
    </div>
  )
}

function EditorRow({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className='flex flex-wrap items-center gap-3'>
      <span className='w-32 shrink-0 text-muted-foreground'>{label}</span>
      {children}
    </div>
  )
}
