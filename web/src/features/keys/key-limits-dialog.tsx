import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiKeyItem } from '@/types/panel-keys'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import type { Vm } from '@/types/panel-vm'
import { isCodexVm } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { KeyGroupType, KeyLimitsDraft } from './key-payload'

const CONC = [0, 1, 2, 4, 8, 16, 20, 32, 64]
const QUOTA_CREATE = [0, 1000, 5000, 10000, 50000]
const QUOTA_EDIT = [0, 1000, 5000, 10000, 50000, 100000]
const RPM_CREATE = [0, 30, 60, 120, 600]
const RPM_EDIT = [0, 30, 60, 120, 300, 600]
const DAYS = [0, 7, 30, 90, 365]

export type { KeyLimitsDraft } from './key-payload'

function withCurrent(opts: number[], current: number): number[] {
  if (opts.includes(current)) return opts
  return [...opts, current].sort((a, b) => a - b)
}

function optLabel(kind: 'conc' | 'quota' | 'rpm' | 'days', n: number): string {
  if (n === 0) {
    if (kind === 'days') return '永久'
    return '不限'
  }
  if (kind === 'quota') {
    if (n >= 1000) return `${n / 1000}k`
    return String(n)
  }
  if (kind === 'days') return n === 365 ? '一年' : `${n} 天`
  return String(n)
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='space-y-1'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function NumSelect({
  value,
  options,
  onChange,
  kind,
}: {
  value: number
  options: number[]
  onChange: (n: number) => void
  kind: 'conc' | 'quota' | 'rpm' | 'days'
}) {
  const opts = withCurrent(options, value)
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {opts.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {optLabel(kind, n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function KeyLimitsDialog({
  mode,
  open,
  onOpenChange,
  initial,
  pending,
  onSubmit,
  vms = [],
}: {
  mode: 'create' | 'edit'
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: ApiKeyItem | null
  pending: boolean
  onSubmit: (draft: KeyLimitsDraft) => void
  vms?: Vm[]
}) {
  const user = useAuthStore((s) => s.me)
  const plans = useQuery({
    queryKey: ['subscription-plans', user?.user],
    queryFn: () =>
      api<{ items: { id: number; name: string }[] }>(
        '/api/panel/subscription-plans'
      ),
    enabled: open,
  })
  const [draft, setDraft] = useState<KeyLimitsDraft>(blankDraft())

  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && initial) {
      const group = groupOf(initial.group_type)
      setDraft({
        name: initial.name || '',
        group_id: initial.group_id,
        category: initial.category === 'api' ? 'api' : 'oauth',
        max_concurrency: Number(initial.max_concurrency ?? 20),
        quota_requests: Number(initial.quota_requests ?? 0),
        quota_usd: Number(initial.quota_usd ?? 0),
        rpm: Number(initial.rpm ?? 0),
        expires_in_days: 0,
        group_type: group,
        allowed_vms: group === 'all' ? [] : initial.allowed_vms || [],
      })
      return
    }
    setDraft(blankDraft())
  }, [open, mode, initial])

  const quotaOpts = mode === 'edit' ? QUOTA_EDIT : QUOTA_CREATE
  const rpmOpts = mode === 'edit' ? RPM_EDIT : RPM_CREATE
  const listed = vmsInGroup(vms || [], draft.group_type)
  const scopeBlocked =
    draft.group_type !== 'all' && draft.allowed_vms.length === 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'create'
              ? '生成密钥'
              : `密钥设置 · ${initial?.name || initial?.id || ''}`}
          </DialogTitle>
        </DialogHeader>
        {mode === 'edit' && initial ? (
          <p className='text-xs text-muted-foreground'>
            <span className='font-mono'>
              {initial.key_prefix || initial.prefix || initial.id}
            </span>
            {initial.inflight ? ` · 进行中 ${initial.inflight}` : ''}
          </p>
        ) : null}
        <div className='grid gap-3 sm:grid-cols-2'>
          <Field label='订阅方案'>
            <select
              aria-label='订阅方案'
              className='h-9 w-full rounded-md border bg-background px-3 text-sm'
              value={draft.group_id || ''}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  group_id: Number(e.target.value) || undefined,
                  category: 'oauth',
                })
              }
            >
              <option value=''>
                {user?.role === 'user'
                  ? '请选择已分配订阅'
                  : '平台 / 原有个人槽位'}
              </option>
              {plans.data?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          {mode === 'create' ? (
            <Field label='名称'>
              <Input
                value={draft.name}
                placeholder='client-a'
                onChange={(e) =>
                  setDraft((d) => ({ ...d, name: e.target.value }))
                }
              />
            </Field>
          ) : null}
          <Field label='分类'>
            <Select
              value={draft.category}
              onValueChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  category: v === 'api' ? 'api' : 'oauth',
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='oauth'>OAuth 槽位</SelectItem>
                {user?.role === 'admin' && !draft.group_id && (
                  <SelectItem value='api'>API 直连</SelectItem>
                )}
              </SelectContent>
            </Select>
          </Field>
          <Field label='并发'>
            <NumSelect
              kind='conc'
              value={draft.max_concurrency}
              options={CONC}
              onChange={(n) => setDraft((d) => ({ ...d, max_concurrency: n }))}
            />
          </Field>
          <Field label='请求额度'>
            <NumSelect
              kind='quota'
              value={draft.quota_requests}
              options={quotaOpts}
              onChange={(n) => setDraft((d) => ({ ...d, quota_requests: n }))}
            />
          </Field>
          <Field label='USD 额度'>
            <Input
              type='number'
              min={0}
              step='0.01'
              value={draft.quota_usd}
              onChange={(e) =>
                setDraft((d) => ({ ...d, quota_usd: Number(e.target.value) }))
              }
            />
          </Field>
          <Field label='RPM'>
            <NumSelect
              kind='rpm'
              value={draft.rpm}
              options={rpmOpts}
              onChange={(n) => setDraft((d) => ({ ...d, rpm: n }))}
            />
          </Field>
          {mode === 'create' ? (
            <Field label='有效期'>
              <NumSelect
                kind='days'
                value={draft.expires_in_days}
                options={DAYS}
                onChange={(n) =>
                  setDraft((d) => ({ ...d, expires_in_days: n }))
                }
              />
            </Field>
          ) : null}
          {user?.role === 'admin' && <><Field label='调用范围'>
            <Select
              value={draft.group_type}
              onValueChange={(v) => {
                const group = groupOf(v)
                const keep = new Set(
                  vmsInGroup(vms || [], group).map((vm) => vm.id)
                )
                setDraft((d) => ({
                  ...d,
                  group_type: group,
                  allowed_vms:
                    group === 'all'
                      ? []
                      : d.allowed_vms.filter((id) => keep.has(id)),
                }))
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>按账户 / 订阅授权范围</SelectItem>
                <SelectItem value='anthropic'>anthropic</SelectItem>
                <SelectItem value='openai'>openai</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {draft.group_type === 'all' ? (
            <p className='text-xs text-muted-foreground sm:col-span-2'>
              使用账户或订阅已授权的槽位；指定平台和槽位可进一步收窄范围。
            </p>
          ) : (
            <div className='sm:col-span-2'>
              <Field label='可用 VM'>
                <div className='max-h-40 space-y-1 overflow-y-auto rounded-md border p-2'>
                  {listed.length === 0 ? (
                    <p className='text-xs text-muted-foreground'>
                      该分组下没有 VM
                    </p>
                  ) : (
                    listed.map((vm) => (
                      <label
                        key={vm.id}
                        className='flex items-center gap-2 text-sm'
                      >
                        <input
                          type='checkbox'
                          className='size-3.5'
                          checked={draft.allowed_vms.includes(vm.id)}
                          onChange={(e) => {
                            const on = e.target.checked
                            setDraft((d) => ({
                              ...d,
                              allowed_vms: on
                                ? [...d.allowed_vms, vm.id]
                                : d.allowed_vms.filter((id) => id !== vm.id),
                            }))
                          }}
                        />
                        <span className='truncate'>
                          {vm.name || vm.email || vm.id}
                        </span>
                        <span className='font-mono text-xs text-muted-foreground'>
                          {vm.id}
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </Field>
            </div>
          )}</>}
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            取消
          </Button>
          <Button
            onClick={() => onSubmit(draft)}
            disabled={
              pending ||
              (mode === 'create' && !draft.name.trim()) ||
              scopeBlocked
            }
            loading={pending}
          >
            {mode === 'create' ? '生成' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function blankDraft(): KeyLimitsDraft {
  return {
    name: '',
    category: 'oauth',
    max_concurrency: 20,
    quota_requests: 0,
    quota_usd: 0,
    rpm: 0,
    expires_in_days: 30,
    group_type: 'all',
    allowed_vms: [],
  }
}

function groupOf(value: string | undefined): KeyGroupType {
  if (value === 'anthropic' || value === 'openai') return value
  return 'all'
}

function vmsInGroup(vms: Vm[], group: KeyGroupType): Vm[] {
  if (group === 'openai') return vms.filter((vm) => isCodexVm(vm))
  if (group === 'anthropic') return vms.filter((vm) => !isCodexVm(vm))
  return []
}
