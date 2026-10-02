import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { vmKindOf } from '@/lib/vm-kind'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Plan } from './index'

export type WizardPreset = {
  mode?: 'new' | 'existing'
  vm?: Vm
  userId?: string
  planId?: number
}
type User = { id: string; username: string; enabled: boolean; role: string }
const selectClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm'
export function SubscriptionWizard({
  preset = {},
  onClose,
}: {
  preset?: WizardPreset
  onClose: () => void
}) {
  const me = useAuthStore((s) => s.me)
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [mode, setMode] = useState(preset.mode || 'existing')
  const [planId, setPlanId] = useState(String(preset.planId || ''))
  const [selected, setSelected] = useState<string[]>(
    preset.userId ? [preset.userId] : []
  )
  const [search, setSearch] = useState('')
  const [daysOverride, setDays] = useState<number>()
  const [draft, setDraft] = useState({
    name: preset.vm ? `${preset.vm.name || preset.vm.id} 共享订阅` : '',
    description: '',
    platform:
      preset.vm && vmKindOf(preset.vm) === 'codex' ? 'openai' : 'claude',
    status: 'active',
    vm_ids: preset.vm ? [preset.vm.id] : ([] as string[]),
    daily_limit_usd: 30,
    weekly_limit_usd: 100,
    default_validity_days: 30,
    subscription_concurrency: 2,
    rate_multiplier: 1,
  })
  const plans = useQuery({
    queryKey: ['subscription-plans', me?.user],
    queryFn: () => api<{ items: Plan[] }>('/api/panel/subscription-plans'),
    staleTime: 0,
  })
  const vms = useQuery({
    queryKey: ['subscription-vms'],
    queryFn: () => api<{ items: Vm[] }>('/api/panel/vms'),
    staleTime: 0,
  })
  const users = useQuery({
    queryKey: ['subscription-users'],
    queryFn: () => api<{ items: User[] }>('/api/panel/users'),
    staleTime: 0,
  })
  const plan =
    mode === 'new'
      ? draft
      : plans.data?.items.find((p) => p.id === Number(planId))
  const days = daysOverride ?? plan?.default_validity_days ?? 30
  const candidates = (users.data?.items || []).filter(
    (u) => u.enabled !== false && u.role !== 'super'
  )
  const recipients = candidates.filter((u) => selected.includes(u.id))
  const error = plans.error || vms.error || users.error
  const loading = plans.isPending || vms.isPending || users.isPending
  const save = useMutation({
    mutationFn: () =>
      api(
        mode === 'new'
          ? '/api/panel/subscriptions/provision'
          : '/api/panel/subscriptions',
        {
          method: 'POST',
          body: JSON.stringify(
            mode === 'new'
              ? {
                  plan: { ...draft, default_validity_days: days },
                  user_ids: selected,
                  validity_days: days,
                }
              : {
                  group_id: Number(planId),
                  user_ids: selected,
                  validity_days: days,
                }
          ),
        }
      ),
    onSuccess: async () => {
      await Promise.all(
        [
          'subscriptions',
          'subscription-plans',
          'subscription-events',
          'subscription-overview',
        ].map((k) => qc.invalidateQueries({ queryKey: [k] }))
      )
      toast.success(`已为 ${selected.length} 位用户分配订阅`)
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const canNext =
    !loading &&
    !error &&
    (step === 0
      ? !!plan && (mode === 'existing' || !!draft.name.trim())
      : step === 1
        ? !!plan?.vm_ids.length
        : step === 2
          ? selected.length > 0 &&
            selected.length <= 100 &&
            selected.length === recipients.length &&
            days >= 1 &&
            days <= 3650 &&
            Number.isInteger(days)
          : true)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose()
      }}
    >
      <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>分配订阅</DialogTitle>
          <DialogDescription>
            选方案、确认账号槽位，再分配给用户。每位用户独立计算额度。
          </DialogDescription>
        </DialogHeader>
        <ol className='grid grid-cols-4 gap-2' aria-label='分配步骤'>
          {['订阅方案', '账号槽位', '选择用户', '确认分配'].map((label, i) => (
            <li
              key={label}
              aria-current={step === i ? 'step' : undefined}
              className={`rounded-lg px-2 py-3 text-center text-xs ${step === i ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              {i + 1}. {label}
            </li>
          ))}
        </ol>
        {error && (
          <p role='alert' className='text-destructive'>
            {error.message}
          </p>
        )}
        {loading && <p>正在加载方案、槽位和用户…</p>}
        <form
          className='space-y-4'
          onSubmit={(e) => {
            e.preventDefault()
            if (!canNext || save.isPending) return
            if (step < 3) setStep(step + 1)
            else save.mutate()
          }}
        >
          {step === 0 && (
            <>
              <div className='flex gap-2'>
                <Button
                  type='button'
                  variant={mode === 'existing' ? 'default' : 'outline'}
                  onClick={() => setMode('existing')}
                >
                  使用已有方案
                </Button>
                <Button
                  type='button'
                  variant={mode === 'new' ? 'default' : 'outline'}
                  onClick={() => setMode('new')}
                >
                  新建方案并分配
                </Button>
              </div>
              {mode === 'existing' ? (
                <label className='grid gap-2 text-sm'>
                  订阅方案
                  <select
                    aria-label='订阅方案'
                    className={selectClass}
                    value={planId}
                    onChange={(e) => {
                      setPlanId(e.target.value)
                      setDays(
                        plans.data?.items.find(
                          (p) => p.id === Number(e.target.value)
                        )?.default_validity_days || 30
                      )
                    }}
                  >
                    <option value=''>请选择方案</option>
                    {plans.data?.items
                      .filter((p) => p.status === 'active')
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {p.vm_ids.length} 个槽位 · {p.members}{' '}
                          位用户
                        </option>
                      ))}
                  </select>
                </label>
              ) : (
                <>
                  <label className='grid gap-2 text-sm'>
                    方案名称
                    <Input
                      required
                      maxLength={80}
                      value={draft.name}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                    />
                  </label>
                  <label className='grid gap-2 text-sm'>
                    平台
                    <select
                      className={selectClass}
                      value={draft.platform}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          platform: e.target.value,
                          vm_ids: [],
                        })
                      }
                    >
                      <option value='claude'>Anthropic / Claude</option>
                      <option value='openai'>OpenAI / Codex</option>
                    </select>
                  </label>
                  <div className='grid grid-cols-2 gap-3'>
                    {(
                      [
                        ['daily_limit_usd', '每人每日额度（USD）'],
                        ['weekly_limit_usd', '每人每周额度（USD）'],
                        ['subscription_concurrency', '每人并发上限'],
                      ] as const
                    ).map(([k, label]) => (
                      <label key={k} className='grid gap-2 text-sm'>
                        {label}
                        <Input
                          required
                          type='number'
                          min={k === 'subscription_concurrency' ? 1 : 0}
                          max={k === 'subscription_concurrency' ? 100 : 1000000}
                          step={k === 'subscription_concurrency' ? 1 : 0.01}
                          value={draft[k]}
                          onChange={(e) =>
                            setDraft({ ...draft, [k]: Number(e.target.value) })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <p className='text-xs text-muted-foreground'>
                    额度填 0 表示不限；上游账号自身限额仍会生效。
                  </p>
                </>
              )}
            </>
          )}
          {step === 1 && (
            <>
              <p className='text-sm'>
                {mode === 'new'
                  ? '勾选此方案使用的槽位。'
                  : '以下为方案已绑定的槽位；更换绑定可到“编辑方案与槽位”。'}
              </p>
              <div className='max-h-72 space-y-2 overflow-y-auto'>
                {vms.data?.items
                  .filter((v) =>
                    mode === 'new'
                      ? (vmKindOf(v) === 'codex' ? 'openai' : 'claude') ===
                        draft.platform
                      : plan?.vm_ids.includes(v.id)
                  )
                  .map((v) => {
                    const bound = plans.data?.items.find((p) =>
                      p.vm_ids.includes(v.id)
                    )
                    const disabled =
                      mode === 'existing' || !!bound || !!v.owner_user_id
                    return (
                      <label
                        key={v.id}
                        className='flex items-center gap-3 rounded-lg border p-3 text-sm'
                      >
                        <input
                          type='checkbox'
                          checked={!!plan?.vm_ids.includes(v.id)}
                          disabled={disabled}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              vm_ids: e.target.checked
                                ? [...draft.vm_ids, v.id]
                                : draft.vm_ids.filter((id) => id !== v.id),
                            })
                          }
                        />
                        <span className='flex-1'>
                          {v.name || v.id}
                          <span className='block text-xs text-muted-foreground'>
                            {bound
                              ? `所属方案：${bound.name} · ${bound.members} 位用户`
                              : v.owner_user_id
                                ? '个人专属槽位'
                                : '尚未绑定订阅'}
                          </span>
                        </span>
                        <span className='text-xs'>
                          {v.has_token ? '已登录' : '待登录上游账号'}
                        </span>
                      </label>
                    )
                  })}
              </div>
              <p className='text-xs text-muted-foreground'>
                可以先分配订阅，再由管理员登录上游账号；未登录时用户首页会提示原因。
              </p>
            </>
          )}
          {step === 2 && (
            <>
              <label className='grid gap-2 text-sm'>
                有效天数
                <Input
                  type='number'
                  min={1}
                  max={3650}
                  step={1}
                  required
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                />
              </label>
              <Input
                aria-label='搜索分配用户'
                placeholder='搜索用户名'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className='max-h-64 space-y-2 overflow-y-auto rounded-lg border p-3'>
                {candidates
                  .filter((u) =>
                    u.username.toLowerCase().includes(search.toLowerCase())
                  )
                  .map((u) => (
                    <label
                      key={u.id}
                      className='flex items-center gap-3 p-2 text-sm'
                    >
                      <input
                        type='checkbox'
                        checked={selected.includes(u.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, u.id]
                              : selected.filter((id) => id !== u.id)
                          )
                        }
                      />
                      {u.username}
                      <span className='text-xs text-muted-foreground'>
                        {u.role === 'admin' ? '管理员' : '普通用户'}
                      </span>
                    </label>
                  ))}
              </div>
              <p className='text-xs text-muted-foreground'>
                找不到用户？
                <Link
                  to='/users'
                  onClick={onClose}
                  className='text-primary underline'
                >
                  前往创建普通用户
                </Link>
                。运维角色不使用个人订阅首页。
              </p>
            </>
          )}
          {step === 3 && plan && (
            <div className='space-y-4 rounded-xl border bg-muted/30 p-5'>
              <h3 className='font-semibold'>{plan.name}</h3>
              <dl className='grid grid-cols-2 gap-3 text-sm'>
                <dt>绑定槽位</dt>
                <dd>
                  {plan.vm_ids
                    .map(
                      (id) =>
                        vms.data?.items.find((v) => v.id === id)?.name || id
                    )
                    .join('、')}
                </dd>
                <dt>每人每日 / 每周额度</dt>
                <dd>
                  {plan.daily_limit_usd ? fmtUsd(plan.daily_limit_usd) : '不限'}{' '}
                  /{' '}
                  {plan.weekly_limit_usd
                    ? fmtUsd(plan.weekly_limit_usd)
                    : '不限'}
                </dd>
                <dt>每人并发 / 有效期</dt>
                <dd>
                  {plan.subscription_concurrency} 路 / {days} 天
                </dd>
                <dt>接收用户</dt>
                <dd className='break-all'>
                  {recipients.map((u) => u.username).join('、')}
                </dd>
              </dl>
              <p className='text-xs text-muted-foreground'>
                已有相同订阅会延长有效期，保留当前用量。每日额度按北京时间 00:00
                重置，每周从首次分配起每 7 天重置。点击确认后生效。
              </p>
            </div>
          )}
          <div className='flex justify-between gap-3 pt-2'>
            <Button
              type='button'
              variant='outline'
              disabled={save.isPending}
              onClick={() => (step ? setStep(step - 1) : onClose())}
            >
              {step ? '上一步' : '取消'}
            </Button>
            <Button type='submit' disabled={!canNext || save.isPending}>
              {save.isPending
                ? '正在分配…'
                : step === 3
                  ? `确认分配给 ${selected.length} 位用户`
                  : '下一步'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
