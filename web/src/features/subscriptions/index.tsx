import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { Vm } from '@/types/panel-vm'
import { Plus, RefreshCw, Users, CreditCard, Server } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { vmKindOf } from '@/lib/vm-kind'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import { plaintextFromPayload } from '@/features/keys/key-format'
import {
  KeyRevealDialog,
  type RevealedKey,
} from '@/features/keys/key-reveal-dialog'
import { SlotLoadPanel } from './admin-overview'
import { BatchActions } from './batch-actions'
import { SubscriptionHome } from './home'
import { SubscriptionWizard, type WizardPreset } from './wizard'

export type Plan = {
  id: number
  name: string
  description: string
  platform: string
  status: string
  vm_ids: string[]
  members: number
  daily_limit_usd: number
  weekly_limit_usd: number
  default_validity_days: number
  subscription_concurrency: number
  group_rpm_limit: number
  user_rpm_limit: number
  rate_multiplier: number
}
export type Subscription = {
  pending_cost?: number
  availability?: { code: string; message: string }
  id: string
  user_id: string
  group_id: number
  username: string
  plan_name: string
  platform: string
  status: string
  plan_status: string
  expires_at: string
  daily_limit_usd: number
  weekly_limit_usd: number
  daily_used: number
  weekly_used: number
  daily_reset_at: string
  weekly_reset_at: string
}
type User = { id: string; username: string; enabled: boolean }
const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'
const statusName: Record<string, string> = {
  active: '生效中',
  expired: '已到期',
  suspended: '已暂停',
  revoked: '已撤销',
}
const date = (value: string) => new Date(value).toLocaleString('zh-CN')
const emptyPlan = {
  name: '',
  description: '',
  platform: 'claude',
  status: 'active',
  vm_ids: [] as string[],
  daily_limit_usd: 30,
  weekly_limit_usd: 100,
  default_validity_days: 30,
  subscription_concurrency: 2,
  group_rpm_limit: 0,
  user_rpm_limit: 0,
  rate_multiplier: 1,
}

export function SubscriptionsPage() {
  const me = useAuthStore((s) => s.me)
  const admin = me?.role === 'admin'
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string[]>([])
  const [tab, setTab] = useState('members')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [planOpen, setPlanOpen] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [draft, setDraft] = useState(emptyPlan)
  const [wizard, setWizard] = useState<WizardPreset | null>(null)

  const [action, setAction] = useState<{
    sub: Subscription
    action: string
  } | null>(null)
  const [renewDays, setRenewDays] = useState(30)
  const [revealed, setRevealed] = useState<RevealedKey | null>(null)
  const plans = useQuery({
    queryKey: ['subscription-plans', me?.user],
    queryFn: () => api<{ items: Plan[] }>('/api/panel/subscription-plans'),
  })
  const subs = useQuery({
    queryKey: ['subscriptions', me?.user],
    queryFn: () => api<{ items: Subscription[] }>('/api/panel/subscriptions'),
    refetchInterval: 30000,
  })
  const users = useQuery({
    queryKey: ['subscription-users'],
    queryFn: () => api<{ items: User[] }>('/api/panel/users'),
    enabled: admin,
  })
  const vms = useQuery({
    queryKey: ['subscription-vms'],
    queryFn: () => api<{ items: Vm[] }>('/api/panel/vms'),
    enabled: admin,
  })
  const events = useQuery({
    queryKey: ['subscription-events'],
    queryFn: () =>
      api<{
        items: {
          id: number
          action: string
          actor_name: string
          plan_name: string
          created_at: string
        }[]
      }>('/api/panel/subscriptions/events'),
    enabled: admin && tab === 'events',
  })
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['subscriptions'] }),
      qc.invalidateQueries({ queryKey: ['subscription-plans'] }),
      qc.invalidateQueries({ queryKey: ['subscription-events'] }),
      qc.invalidateQueries({ queryKey: ['subscription-overview'] }),
    ])
  }
  const mutate = useMutation({
    mutationFn: ({
      path,
      body,
      method = 'POST',
    }: {
      path: string
      body: unknown
      method?: string
    }) => api(path, { method, body: JSON.stringify(body) }),
    onSuccess: async () => {
      toast.success('已保存')
      setPlanOpen(false)

      setAction(null)
      await refresh()
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const key = useMutation({
    mutationFn: (sub: Subscription) =>
      api('/api/panel/api-keys', {
        method: 'POST',
        body: JSON.stringify({
          name: `${sub.plan_name} · ${sub.username || me?.user}`,
          group_id: sub.group_id,
          user_id: sub.user_id,
          category: 'oauth',
          max_concurrency: 2,
        }),
      }),
    onSuccess: (data) => {
      const value = plaintextFromPayload(data)
      if (value)
        setRevealed({
          title: '订阅密钥已创建',
          name: '复制到客户端使用',
          key: value,
        })
      void qc.invalidateQueries({ queryKey: ['panel', 'api-keys'] })
    },
    onError: (e: Error) => toast.error(e.message),
  })
  const items = subs.data?.items || []
  const visible = items.filter(
    (s) =>
      (!search ||
        `${s.username} ${s.plan_name}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (filter === 'all' || s.status === filter)
  )
  const active = items.filter(
    (s) => s.status === 'active' && s.plan_status === 'active'
  )
  const error =
    subs.error || plans.error || (admin ? users.error || vms.error : null)
  if (!admin)
    return (
      <PageHeader
        title='我的订阅'
        extra={
          <Button variant='outline' onClick={() => void refresh()}>
            刷新
          </Button>
        }
      >
        <SubscriptionHome
          items={items}
          loading={subs.isPending}
          error={subs.error}
          onCreate={(s) => key.mutate(s)}
          pending={key.isPending}
        />
        <KeyRevealDialog value={revealed} onClose={() => setRevealed(null)} />
      </PageHeader>
    )
  return (
    <PageHeader
      title={admin ? '订阅管理' : '我的订阅'}
      extra={
        <div className='flex gap-2'>
          <Button variant='outline' onClick={() => void refresh()}>
            <RefreshCw className='size-4' />
            刷新
          </Button>
          {admin && (
            <>
              <Button
                variant='outline'
                onClick={() => {
                  setWizard({ mode: 'new' })
                }}
              >
                <Plus className='size-4' />
                创建方案
              </Button>
              <Button
                onClick={() => {
                  setWizard({ mode: 'existing' })
                }}
              >
                <Users className='size-4' />
                分配订阅
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className='mb-6 grid gap-4 sm:grid-cols-3'>
        <StatCard label='生效订阅' value={String(active.length)} />
        <StatCard
          label={admin ? '订阅用户' : '今日额度消耗'}
          value={
            admin
              ? String(new Set(active.map((s) => s.user_id)).size)
              : fmtUsd(items.reduce((a, s) => a + s.daily_used, 0))
          }
        />
        <StatCard
          label={admin ? '订阅方案' : '近周期额度消耗'}
          value={
            admin
              ? String(plans.data?.items.length || 0)
              : fmtUsd(items.reduce((a, s) => a + s.weekly_used, 0))
          }
        />
      </div>
      {admin && (
        <div className='mb-4 flex flex-wrap gap-2'>
          {[
            ['members', '用户订阅'],
            ['plans', '订阅方案'],
            ['slots', '槽位负载'],
            ['events', '操作记录'],
          ].map(([id, label]) => (
            <Button
              key={id}
              variant={tab === id ? 'default' : 'outline'}
              onClick={() => setTab(id)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role='alert' className='mb-4 text-destructive'>
          {error.message}
        </p>
      )}
      {subs.isLoading && (
        <p className='p-8 text-muted-foreground'>正在加载订阅…</p>
      )}
      {tab === 'slots' && <SlotLoadPanel />}
      {(tab === 'members' || !admin) && (
        <>
          <div className='mb-4 flex flex-wrap gap-3'>
            <Input
              className='max-w-sm'
              aria-label='搜索订阅'
              placeholder={admin ? '搜索用户或方案' : '搜索方案'}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setSelected([])
              }}
            />
            <select
              aria-label='订阅状态'
              className={selectClass}
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value)
                setSelected([])
              }}
            >
              <option value='all'>全部状态</option>
              {Object.entries(statusName).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <Link
              to='/usage-records'
              className='self-center text-sm text-primary hover:underline'
            >
              查看使用明细 →
            </Link>
          </div>
          <div className='mb-3'>
            <BatchActions
              items={visible.filter((s) => selected.includes(s.id))}
              onDone={() => setSelected([])}
            />
          </div>
          <div className='overflow-x-auto rounded-xl border bg-card'>
            <table className='w-full text-left text-sm'>
              <thead className='border-b bg-muted/40'>
                <tr>
                  <th className='p-4'>
                    <input
                      type='checkbox'
                      className='size-4 accent-primary'
                      aria-label='选择当前结果（最多100个）'
                      checked={
                        visible.length > 0 &&
                        visible
                          .slice(0, 100)
                          .every((s) => selected.includes(s.id))
                      }
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? visible.slice(0, 100).map((s) => s.id)
                            : []
                        )
                      }
                    />
                  </th>
                  {[
                    ...(admin ? ['用户'] : []),
                    '订阅方案',
                    '个人额度',
                    '到期时间',
                    '状态',
                    '操作',
                  ].map((h) => (
                    <th key={h} className='p-4 font-medium'>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id} className='border-b last:border-0'>
                    <td className='p-4'>
                      <input
                        type='checkbox'
                        className='size-4 accent-primary'
                        aria-label={`选择 ${s.username} ${s.plan_name}`}
                        checked={selected.includes(s.id)}
                        onChange={(e) =>
                          setSelected((v) =>
                            e.target.checked
                              ? [...v, s.id]
                              : v.filter((id) => id !== s.id)
                          )
                        }
                      />
                    </td>
                    {admin && <td className='p-4 font-medium'>{s.username}</td>}
                    <td className='p-4'>
                      <div className='flex items-center gap-2'>
                        <CreditCard className='size-4 text-primary' />
                        {s.plan_name}
                      </div>
                      <span className='mt-1 block text-xs text-muted-foreground'>
                        {s.platform === 'openai'
                          ? 'OpenAI / Codex'
                          : 'Anthropic / Claude'}
                      </span>
                    </td>
                    <td className='min-w-64 p-4'>
                      <Quota
                        label='每日'
                        used={s.daily_used}
                        limit={s.daily_limit_usd}
                        reset={s.daily_reset_at}
                      />
                      <Quota
                        label='每周'
                        used={s.weekly_used}
                        limit={s.weekly_limit_usd}
                        reset={s.weekly_reset_at}
                      />
                    </td>
                    <td className='p-4 whitespace-nowrap'>
                      {date(s.expires_at)}
                    </td>
                    <td className='p-4'>
                      <Badge
                        variant={
                          s.status === 'active' && s.plan_status === 'active'
                            ? 'secondary'
                            : 'outline'
                        }
                      >
                        {s.plan_status === 'disabled'
                          ? '方案已停用'
                          : statusName[s.status] || s.status}
                      </Badge>
                    </td>
                    <td className='min-w-44 p-4'>
                      <div className='flex flex-wrap gap-1'>
                        {s.status === 'active' &&
                          s.plan_status === 'active' && (
                            <Button
                              size='sm'
                              variant='outline'
                              disabled={key.isPending}
                              onClick={() => key.mutate(s)}
                            >
                              创建密钥
                            </Button>
                          )}
                        {admin && (
                          <>
                            {s.status === 'revoked' && (
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={s.plan_status !== 'active'}
                                onClick={() =>
                                  setWizard({
                                    planId: s.group_id,
                                    userId: s.user_id,
                                  })
                                }
                              >
                                重新分配
                              </Button>
                            )}
                            {[
                              ['renew', '续期'],
                              ['reset', '重置额度'],
                              [
                                s.status === 'suspended'
                                  ? 'active'
                                  : 'suspended',
                                s.status === 'suspended' ? '恢复' : '暂停',
                              ],
                              ['revoked', '撤销'],
                            ]
                              .filter(
                                ([a]) => s.status !== 'revoked' || a === 'reset'
                              )
                              .map(([a, l]) => (
                                <Button
                                  key={a}
                                  size='sm'
                                  variant='ghost'
                                  onClick={() => {
                                    setRenewDays(30)
                                    setAction({ sub: s, action: a })
                                  }}
                                >
                                  {l}
                                </Button>
                              ))}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!subs.isLoading && !visible.length && (
              <div className='p-12 text-center text-muted-foreground'>
                {admin
                  ? '暂无订阅。创建方案并分配给用户后，将显示在这里。'
                  : '你还没有订阅，请联系管理员分配。'}
              </div>
            )}
          </div>
        </>
      )}
      {admin && tab === 'plans' && (
        <div className='grid gap-4 lg:grid-cols-2'>
          {plans.data?.items.map((p) => (
            <div key={p.id} className='rounded-xl border bg-card p-5'>
              <div className='mb-4 flex items-center justify-between'>
                <h3 className='text-lg font-semibold'>{p.name}</h3>
                <Badge variant='outline'>
                  {p.status === 'active' ? '启用' : '停用'}
                </Badge>
              </div>
              <p className='text-sm text-muted-foreground'>
                {p.description || '共享槽位 · 独立用户额度'}
              </p>
              <div className='my-4 grid grid-cols-2 gap-3 text-sm'>
                <span>
                  每日 {p.daily_limit_usd ? fmtUsd(p.daily_limit_usd) : '不限'}
                </span>
                <span>
                  每周{' '}
                  {p.weekly_limit_usd ? fmtUsd(p.weekly_limit_usd) : '不限'}
                </span>
                <span>{p.members} 位有效用户</span>
                <span>每人 {p.subscription_concurrency} 路并发</span>
                <span>
                  分组总 RPM：{p.group_rpm_limit || '不限'} · 每人 RPM：
                  {p.user_rpm_limit || '不限'}
                </span>
              </div>
              <div className='mb-4 flex flex-wrap gap-2'>
                {p.vm_ids.map((id) => (
                  <Link
                    key={id}
                    to='/vm/$id'
                    params={{ id }}
                    className='inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs'
                  >
                    <Server className='size-3' />
                    {id}
                  </Link>
                ))}
              </div>
              <Button
                variant='outline'
                onClick={() => {
                  setEditId(p.id)
                  setDraft({ ...p })
                  setPlanOpen(true)
                }}
              >
                编辑方案与槽位
              </Button>
              <Button
                className='ml-2'
                disabled={p.status !== 'active'}
                onClick={() => setWizard({ planId: p.id })}
              >
                分配给用户
              </Button>
            </div>
          ))}
          {!plans.data?.items.length && (
            <p className='p-8 text-muted-foreground'>
              还没有订阅方案，点击“创建方案”开始。
            </p>
          )}
        </div>
      )}
      {admin && tab === 'events' && (
        <div className='rounded-xl border'>
          {events.error && (
            <p role='alert' className='p-4 text-destructive'>
              {events.error.message}
            </p>
          )}
          {events.data?.items.map((e) => (
            <div
              key={e.id}
              className='flex flex-wrap justify-between gap-2 border-b p-4 text-sm last:border-0'
            >
              <span>
                {e.plan_name || '订阅'} ·{' '}
                {(
                  {
                    assigned: '分配订阅',
                    renewed: '续期',
                    reassigned: '重新分配',
                    renew: '续期',
                    reset: '重置额度',
                    active: '恢复',
                    suspended: '暂停',
                    revoked: '撤销',
                    plan_created: '创建方案',
                    plan_updated: '修改方案',
                    interrupted_reservation_released:
                      '中断请求待核查（已释放预留）',
                  } as Record<string, string>
                )[e.action] || e.action}
              </span>
              <span className='text-muted-foreground'>
                {e.actor_name || '系统'} · {date(e.created_at)}
              </span>
            </div>
          ))}
          {events.data?.items.length === 0 && (
            <p className='p-8 text-muted-foreground'>暂无操作记录</p>
          )}
        </div>
      )}
      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className='max-h-[90vh] overflow-y-auto sm:max-w-xl'>
          <DialogHeader>
            <DialogTitle>
              {editId ? '编辑订阅方案' : '创建订阅方案'}
            </DialogTitle>
          </DialogHeader>
          <form
            className='space-y-4'
            onSubmit={(e) => {
              e.preventDefault()
              mutate.mutate({
                path: `/api/panel/subscription-plans${editId ? '/' + editId : ''}`,
                method: editId ? 'PATCH' : 'POST',
                body: draft,
              })
            }}
          >
            <label className='grid gap-2 text-sm'>
              方案名称
              <Input
                required
                maxLength={80}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder='例如 Claude Pro 共享订阅'
              />
            </label>
            <label className='grid gap-2 text-sm'>
              说明
              <Input
                value={draft.description}
                onChange={(e) =>
                  setDraft({ ...draft, description: e.target.value })
                }
              />
            </label>
            <div className='grid grid-cols-2 gap-3'>
              <label className='grid gap-2 text-sm'>
                平台
                <select
                  className={selectClass}
                  value={draft.platform}
                  onChange={(e) =>
                    setDraft({ ...draft, platform: e.target.value, vm_ids: [] })
                  }
                >
                  <option value='claude'>Anthropic / Claude</option>
                  <option value='openai'>OpenAI / Codex</option>
                </select>
              </label>
              <label className='grid gap-2 text-sm'>
                状态
                <select
                  className={selectClass}
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({ ...draft, status: e.target.value })
                  }
                >
                  <option value='active'>启用</option>
                  <option value='disabled'>停用</option>
                </select>
              </label>
            </div>
            <fieldset className='rounded-lg border p-3'>
              <legend className='px-1 text-sm'>绑定槽位（可多选）</legend>
              <p className='mb-2 text-xs text-muted-foreground'>
                同一槽位可绑定多个套餐，各套餐额度和限流独立，合计仍受槽位自身容量限制。
              </p>
              <div className='max-h-40 space-y-2 overflow-y-auto'>
                {vms.data?.items
                  .filter(
                    (v) =>
                      (vmKindOf(v) === 'codex' ? 'openai' : 'claude') ===
                      draft.platform
                  )
                  .map((v) => {
                    const bound = plans.data?.items.filter(
                      (p) => p.id !== editId && p.vm_ids.includes(v.id)
                    )
                    return (
                      <label
                        key={v.id}
                        className='flex items-center gap-2 text-sm'
                      >
                        <input
                          type='checkbox'
                          disabled={!!v.owner_user_id}
                          checked={draft.vm_ids.includes(v.id)}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              vm_ids: e.target.checked
                                ? [...draft.vm_ids, v.id]
                                : draft.vm_ids.filter((x) => x !== v.id),
                            })
                          }
                        />
                        {v.name || v.id} · {v.id}
                        {bound?.length
                          ? `（已关联：${bound.map((p) => p.name).join('、')}，可共享）`
                          : v.owner_user_id
                            ? '（个人槽位）'
                            : ''}
                      </label>
                    )
                  })}
              </div>
            </fieldset>
            <div className='grid grid-cols-2 gap-3'>
              {(
                [
                  ['daily_limit_usd', '每人每日额度（USD，0 不限）'],
                  ['weekly_limit_usd', '每人每周额度（USD，0 不限）'],
                  ['default_validity_days', '默认有效天数'],
                  ['subscription_concurrency', '每人最大并发'],
                  ['group_rpm_limit', '分组总 RPM（0 不限）'],
                  ['user_rpm_limit', '分组内每人 RPM（0 不限）'],
                  ['rate_multiplier', '额度倍率'],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className='grid gap-2 text-sm'>
                  {l}
                  <Input
                    required
                    type='number'
                    min={
                      k === 'default_validity_days' ||
                      k === 'subscription_concurrency'
                        ? 1
                        : 0
                    }
                    step={
                      k.includes('usd') || k === 'rate_multiplier'
                        ? '0.01'
                        : '1'
                    }
                    value={draft[k]}
                    onChange={(e) =>
                      setDraft({ ...draft, [k]: Number(e.target.value) })
                    }
                  />
                </label>
              ))}
            </div>
            <p className='text-xs text-muted-foreground'>
              分组总 RPM 由所有用户共享，每人 RPM
              合并该用户在本分组的所有密钥；按最近 60 秒计数，0
              表示不限。每日额度于北京时间 00:00 重置，每周从分配时间起每 7
              天重置。请求会预留预计用量，结束后按实际用量结算。上游账号限额独立生效。
            </p>
            <Button
              type='submit'
              disabled={
                mutate.isPending ||
                (draft.status === 'active' && !draft.vm_ids.length)
              }
              className='w-full'
            >
              保存方案
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      {wizard && (
        <SubscriptionWizard preset={wizard} onClose={() => setWizard(null)} />
      )}
      <Dialog
        open={!!action}
        onOpenChange={(open) => {
          if (!open) setAction(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>调整 {action?.sub.username} 的订阅</DialogTitle>
          </DialogHeader>
          <p className='text-sm'>
            {action?.sub.plan_name} ·{' '}
            {action?.action === 'reset'
              ? '重置个人额度，历史明细保留。'
              : action?.action === 'renew'
                ? '从当前到期时间或今天起延长有效期。'
                : `将订阅设为${statusName[action?.action || ''] || ''}。`}
          </p>
          {action?.action === 'renew' && (
            <label className='grid gap-2 text-sm'>
              续期天数
              <Input
                type='number'
                min={1}
                value={renewDays}
                onChange={(e) => setRenewDays(Number(e.target.value))}
              />
            </label>
          )}
          <Button
            disabled={mutate.isPending}
            onClick={() => {
              if (action)
                mutate.mutate({
                  path: `/api/panel/subscriptions/${action.sub.id}`,
                  method: 'PATCH',
                  body: ['reset', 'renew'].includes(action.action)
                    ? { action: action.action, days: renewDays }
                    : { status: action.action },
                })
            }}
          >
            确认调整
          </Button>
        </DialogContent>
      </Dialog>
      <KeyRevealDialog value={revealed} onClose={() => setRevealed(null)} />
    </PageHeader>
  )
}

function Quota({
  label,
  used,
  limit,
  reset,
}: {
  label: string
  used: number
  limit: number
  reset: string
}) {
  return (
    <div className='mb-2 last:mb-0'>
      <div className='mb-1 flex justify-between gap-4 text-xs'>
        <span>{label}</span>
        <span>
          {fmtUsd(used)} / {limit ? fmtUsd(limit) : '不限'}
        </span>
      </div>
      <Progress
        value={limit ? Math.min(100, (used / limit) * 100) : 0}
        className='h-1.5'
      />
      <div className='mt-1 text-[11px] text-muted-foreground'>
        {date(reset)} 重置
      </div>
    </div>
  )
}
