import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { JevInterceptConfig, JevScopeOption } from '@/types/panel-routing'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SaveBar } from '@/features/settings/save-bar'
import { Group, Panel } from './blocks'
import { type AccountScope, scopeConfigured, scopeMatches } from './model'
import { jevInterceptQueryOptions } from './queries'

type Draft = {
  account_types: string[]
  account_plan_types: string[]
  account_ids: string
}

function draftOf(data: JevInterceptConfig): Draft {
  return {
    account_types: data.account_types || [],
    account_plan_types: data.account_plan_types || [],
    account_ids: (data.account_ids || []).join('\n'),
  }
}

function linesOf(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function scopeOf(draft: Draft): AccountScope {
  return {
    account_types: draft.account_types,
    account_plan_types: draft.account_plan_types,
    account_ids: linesOf(draft.account_ids),
  }
}

function sameScope(left: AccountScope, right: AccountScope) {
  return (
    [...left.account_types].sort().join('\n') ===
      [...right.account_types].sort().join('\n') &&
    [...left.account_plan_types].sort().join('\n') ===
      [...right.account_plan_types].sort().join('\n') &&
    [...left.account_ids].sort().join('\n') ===
      [...right.account_ids].sort().join('\n')
  )
}

function Chip({
  option,
  active,
  onToggle,
}: {
  option: JevScopeOption
  active: boolean
  onToggle: () => void
}) {
  return (
    <button
      type='button'
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        'flex cursor-pointer items-baseline gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors duration-150',
        active
          ? 'border-select-border bg-select-surface text-foreground'
          : 'border-border bg-card text-muted-foreground hover:border-select-border/60 hover:text-foreground'
      )}
    >
      <span>{option.label}</span>
      <span className='tabular-nums opacity-60'>{option.count}</span>
    </button>
  )
}

function Options({
  title,
  hint,
  options,
  selected,
  onToggle,
  onClear,
}: {
  title: string
  hint: string
  options: JevScopeOption[]
  selected: string[]
  onToggle: (id: string) => void
  onClear: () => void
}) {
  return (
    <Group
      title={title}
      hint={hint}
      action={
        selected.length ? (
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='cursor-pointer text-xs'
            onClick={onClear}
          >
            清空
          </Button>
        ) : undefined
      }
    >
      <div className='flex flex-wrap gap-2'>
        {options.map((option) => (
          <Chip
            key={option.id}
            option={option}
            active={selected.includes(option.id)}
            onToggle={() => onToggle(option.id)}
          />
        ))}
      </div>
    </Group>
  )
}

/**
 * 风控的账号范围：跟 sub2api 的内容审核一样，按账号类型 / 套餐类型 / 指定账号
 * 收窄关卡覆盖的槽位。三个列表取并集，全空 = 所有账号都进关卡（旧行为）。
 */
export function AccountScopeSettings() {
  const qc = useQueryClient()
  const q = useQuery(jevInterceptQueryOptions())
  const [draft, setDraft] = useState<Draft | null>(null)

  useEffect(() => {
    if (q.data) setDraft(draftOf(q.data))
  }, [q.data])

  const saved = q.data ? draftOf(q.data) : null
  const current = draft ? scopeOf(draft) : null
  const dirty = !!current && !!saved && !sameScope(current, scopeOf(saved))

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('没有可保存的配置')
      return api<JevInterceptConfig>('/api/panel/jev-intercept', {
        method: 'PUT',
        body: JSON.stringify({
          account_types: draft.account_types,
          account_plan_types: draft.account_plan_types,
          account_ids: linesOf(draft.account_ids),
        }),
      })
    },
    onSuccess: (data) => {
      toast.success('已保存账号范围')
      qc.setQueryData(jevInterceptQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p className='p-4 text-sm text-destructive' role='alert'>
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft || !current)
    return <div className='h-40 animate-pulse bg-muted/40' />

  const inventory = q.data?.account_scope
  const accounts = inventory?.accounts || []
  const total = inventory?.accounts_total ?? accounts.length
  const configured = scopeConfigured(current)
  const matched = configured ? scopeMatches(current, accounts) : accounts
  const preview = matched
    .slice(0, 6)
    .map((account) => account.email || account.id)

  const toggle = (key: 'account_types' | 'account_plan_types', id: string) =>
    setDraft({
      ...draft,
      [key]: draft[key].includes(id)
        ? draft[key].filter((item) => item !== id)
        : [...draft[key], id],
    })

  return (
    <Panel
      title='账号范围'
      hint='范围只决定“哪些账号的请求进关卡”。三个列表都不选 = 所有账号都进关卡。'
    >
      <div className='space-y-6 p-4'>
        <p className='rounded-lg border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground'>
          勾选后只有命中的账号会被四道关检查，其它账号的请求直接放行。 GPT /
          Codex 按请求实际落到的槽位判定；选了范围就不再受「OpenAI
          平台」开关影响，Claude 流量始终进关卡。
        </p>

        <Options
          title='账号类型'
          hint='按槽位的凭证形式。Console API Key 与 Setup Token 分开算。'
          options={inventory?.account_type_options || []}
          selected={draft.account_types}
          onToggle={(id) => toggle('account_types', id)}
          onClear={() => setDraft({ ...draft, account_types: [] })}
        />

        <Options
          title='套餐类型'
          hint='按上游套餐判定，括号里是当前槽位数。'
          options={inventory?.account_plan_type_options || []}
          selected={draft.account_plan_types}
          onToggle={(id) => toggle('account_plan_types', id)}
          onClear={() => setDraft({ ...draft, account_plan_types: [] })}
        />

        <Group
          title='指定账号'
          hint='一行一个：槽位 id、邮箱或名称。留空即不按账号限制。'
        >
          <Textarea
            aria-label='指定账号'
            rows={3}
            className='font-mono text-xs'
            placeholder={'vm-02\naldanacharles9564@aol.com'}
            value={draft.account_ids}
            onChange={(event) =>
              setDraft({ ...draft, account_ids: event.target.value })
            }
          />
        </Group>

        <div className='space-y-1 rounded-lg border bg-card px-3 py-2 text-xs leading-5'>
          <p className='font-medium'>
            {configured
              ? `当前范围命中 ${matched.length} / ${total} 个槽位`
              : `当前范围：全部账号（${total} 个槽位）`}
          </p>
          {configured && !matched.length ? (
            <p className='text-[var(--status-caution)]'>
              没有槽位命中，等于所有请求都不检查。请重选。
            </p>
          ) : preview.length ? (
            <p className='truncate text-muted-foreground'>
              例如：{preview.join('、')}
              {matched.length > preview.length ? ' …' : ''}
            </p>
          ) : null}
        </div>

        {dirty ? (
          <SaveBar
            saving={save.isPending}
            onSave={() => save.mutate()}
            onDiscard={() => q.data && setDraft(draftOf(q.data))}
          />
        ) : null}
      </div>
    </Panel>
  )
}
