import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import type { ApiKeyItem } from '@/types/panel-keys'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { StatCard } from '@/components/stat-card'
import { StatusMark } from '@/components/status-mark'
import { apiKeysQueryOptions } from '@/features/keys/queries'
import { DateRange } from '@/features/usage-records/date-range'
import {
  usageDates,
  usageMoney,
  usageTokens,
  type KeyUsage,
  type UsageSearch,
} from '@/features/usage-records/filters'
import { vmsListQueryOptions } from '@/features/vm/queries'
import {
  keyIsDead,
  keyQuotaLabel,
  keyQuotaPct,
  keyStatusTone,
  maskApiKeyItem,
  plaintextFromPayload,
} from './key-format'
import { KeyLimitsDialog } from './key-limits-dialog'
import { keyLimitsPayload, type KeyLimitsDraft } from './key-payload'
import { KeyRevealDialog, type RevealedKey } from './key-reveal-dialog'
import { KeyStatsDialog } from './key-stats-dialog'
import { VmPoolsCard, vmPoolsQueryOptions } from './vm-pools-card'

export function KeysPage() {
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.me)
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as UsageSearch
  const { from, until, valid } = usageDates(search)
  const setRange = (patch: UsageSearch) =>
    void navigate({
      to: '/keys',
      search: { ...search, ...patch },
      replace: true,
    })
  const [filter, setFilter] = useState('')
  const [resetId, setResetId] = useState('')
  const [details, setDetails] = useState<ApiKeyItem | null>(null)
  const stats = useQuery({
    queryKey: ['key-usage', me?.user, from, until],
    enabled: valid,
    queryFn: () =>
      api<{ keys: KeyUsage[] }>(
        `/api/panel/usage-records?${new URLSearchParams({ from: new Date(from + 'T00:00:00').toISOString(), until: new Date(until + 'T23:59:59.999').toISOString() })}`
      ),
  })
  const plans = useQuery({
    queryKey: ['subscription-plans', me?.user],
    queryFn: () =>
      api<{ items: { id: number; name: string }[] }>(
        '/api/panel/subscription-plans'
      ),
  })
  const metrics = new Map(stats.data?.keys.map((k) => [k.api_key_id, k]))
  const metricsReady = valid && stats.isSuccess && !stats.isError
  const q = useQuery(apiKeysQueryOptions())
  const isAdmin = me?.role === 'admin'
  const pools = useQuery({ ...vmPoolsQueryOptions(), enabled: isAdmin })
  const vms = useQuery(vmsListQueryOptions())
  const vmItems = vms.data?.items || []
  const [createOpen, setCreateOpen] = useState(false)
  const [editId, setEditId] = useState('')
  const [statsId, setStatsId] = useState('')
  const [rotateId, setRotateId] = useState('')
  const [revealed, setRevealed] = useState<RevealedKey | null>(null)
  const [delId, setDelId] = useState('')
  const keys = q.data?.keys || []
  const visible = keys.filter((k) =>
    (k.name || '').toLowerCase().includes(filter.toLowerCase())
  )
  const total = visible.reduce(
    (a, k) => {
      const u = metrics.get(k.id)
      return {
        requests: a.requests + (u?.requests || 0),
        tokens: a.tokens + usageTokens(u),
        cost: a.cost + (u?.actual_cost || 0),
      }
    },
    { requests: 0, tokens: 0, cost: 0 }
  )
  const rangeSearch = {
    range: search.range,
    from: search.from,
    until: search.until,
  }
  const editing = keys.find((k) => k.id === editId) || null
  const rotating = keys.find((k) => k.id === rotateId) || null
  const refresh = () =>
    qc.invalidateQueries({ queryKey: apiKeysQueryOptions().queryKey })

  const create = useMutation({
    mutationFn: (draft: KeyLimitsDraft) => {
      const body = keyLimitsPayload(draft, 'create')
      return api<unknown>('/api/panel/api-keys', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    },
    onSuccess: async (data) => {
      const key = plaintextFromPayload(data)
      setCreateOpen(false)
      if (key) {
        setRevealed({ title: '已生成', name: draftName(data), key })
      } else {
        toast.success('已创建')
      }
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const edit = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: KeyLimitsDraft }) =>
      api(`/api/panel/api-keys/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(keyLimitsPayload(draft, 'edit')),
      }),
    onSuccess: async () => {
      toast.success('密钥设置已更新')
      setEditId('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const toggle = useMutation({
    mutationFn: ({ id, enable }: { id: string; enable: boolean }) =>
      api(`/api/panel/api-keys/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: enable ? 'active' : 'disabled' }),
      }),
    onSuccess: async (_data, vars) => {
      toast.success(vars.enable ? '已启用' : '已停用')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const resetQuota = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/api-keys/${encodeURIComponent(id)}/reset-quota`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      toast.success('已重置密钥自身的限额计数，订阅额度和历史用量不变')
      setResetId('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const reveal = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/panel/api-keys/${encodeURIComponent(id)}/reveal`, {
        method: 'POST',
      }),
    onError: (error: Error) => toast.error(error.message),
  })

  const rotate = useMutation({
    mutationFn: (id: string) =>
      api<unknown>(`/api/panel/api-keys/${encodeURIComponent(id)}/rotate`, {
        method: 'POST',
      }),
    onSuccess: async (data) => {
      const key = plaintextFromPayload(data)
      setRotateId('')
      if (key) setRevealed({ title: '已换新', name: draftName(data), key })
      else toast.success('已换新')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/panel/api-keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('已删除')
      setDelId('')
      await refresh()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  async function viewPlain(k: ApiKeyItem) {
    try {
      const data = await reveal.mutateAsync(k.id)
      const key = plaintextFromPayload(data)
      if (!key) {
        toast.error('无法还原明文 · 请换新')
        return
      }
      setRevealed({ title: '查看密钥', name: k.name, id: k.id, key })
    } catch {
      /* onError 已 toast */
    }
  }

  async function copyPlain(k: ApiKeyItem) {
    try {
      const data = await reveal.mutateAsync(k.id)
      const key = plaintextFromPayload(data)
      if (!key) {
        toast.error('无法还原明文 · 请换新')
        return
      }
      if (await copyText(key)) {
        toast.success('已复制明文密钥，请妥善保存')
        return
      }
      // The browser refused (plain HTTP without execCommand, or the click's
      // activation expired while revealing): hand the key over in the dialog,
      // whose own button is a fresh gesture.
      setRevealed({ title: '复制密钥', name: k.name, id: k.id, key })
      toast.warning('浏览器拦截了自动复制，请在弹层中点「复制」或手动选中')
    } catch {
      /* onError 已 toast */
    }
  }

  return (
    <PageHeader
      title={me?.role === 'user' ? '我的密钥' : '密钥管理'}
      extra={
        <div className='flex gap-2'>
          <Button
            variant='outline'
            disabled={!valid || stats.isFetching}
            onClick={() => {
              void refresh()
              void stats.refetch()
            }}
          >
            刷新
          </Button>
          <Button onClick={() => setCreateOpen(true)}>创建密钥</Button>
        </div>
      }
    >
      {isAdmin ? <VmPoolsCard vms={vmItems} /> : null}
      <p className='mb-5 text-sm text-muted-foreground'>
        按所选时间查看每个 Key 的用量。同一订阅下的密钥共享你的订阅额度。
      </p>
      <div className='mb-5 rounded-xl border bg-card p-4'>
        <DateRange search={search} onChange={setRange} />
        <p className='mt-3 text-xs text-muted-foreground'>
          日期按浏览器本地时区计算；统计来自保留的调用记录，不代表上游账号剩余额度。
        </p>
      </div>
      <div className='mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4'>
        <StatCard
          compact
          label='当前列表密钥'
          value={String(visible.length)}
          hint='包含已停用密钥'
        />
        <StatCard
          compact
          label='请求数'
          value={metricsReady ? fmtNum(total.requests) : '—'}
          hint='所选时间范围'
        />
        <StatCard
          compact
          label='Token'
          value={metricsReady ? fmtNum(total.tokens) : '—'}
          hint='输入、输出及缓存合计'
        />
        <StatCard
          compact
          label='额度消耗'
          value={metricsReady ? usageMoney(total.cost) : '—'}
          hint='所选时间范围'
        />
      </div>
      <div className='mb-4 flex flex-wrap items-center justify-between gap-3'>
        <Input
          className='max-w-sm'
          aria-label='搜索密钥'
          placeholder='搜索密钥名称'
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button variant='outline' asChild>
          <Link to='/usage-records' search={rangeSearch}>
            对比密钥用量
          </Link>
        </Button>
      </div>
      {stats.error && (
        <p role='alert' className='mb-3 text-sm text-destructive'>
          用量加载失败：{stats.error.message}。请点击刷新重试。
        </p>
      )}
      {plans.error && (
        <p role='alert' className='mb-3 text-sm text-destructive'>
          订阅名称加载失败，暂时显示订阅编号。
        </p>
      )}
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={<TableSkeleton rows={5} columns={7} />}
      >
        {!keys.length ? (
          <EmptyState
            reason='还没有密钥。选择已分配的订阅，创建一个 Key 后即可接入客户端。'
            actionLabel='创建密钥'
            onAction={() => setCreateOpen(true)}
          />
        ) : !visible.length ? (
          <p className='rounded-xl border p-8 text-center text-muted-foreground'>
            没有匹配的密钥
          </p>
        ) : (
          <div className='space-y-3 xl:space-y-0 xl:overflow-hidden xl:rounded-xl xl:border xl:bg-card'>
            <div className='hidden grid-cols-[minmax(170px,2fr)_80px_80px_90px_110px_minmax(130px,1fr)_190px] gap-3 border-b bg-muted/40 px-4 py-3 text-xs text-muted-foreground xl:grid'>
              <span>名称 / 所属订阅</span>
              <span>状态</span>
              <span>请求数</span>
              <span>Token</span>
              <span>额度消耗</span>
              <span>范围内最近调用</span>
              <span className='text-right'>操作</span>
            </div>
            {visible.map((k) => (
              <KeyRow
                key={k.id}
                item={k}
                usage={metrics.get(k.id)}
                ready={metricsReady}
                range={rangeSearch}
                planName={
                  plans.data?.items.find((p) => p.id === k.group_id)?.name ||
                  (k.group_id ? `订阅 #${k.group_id}` : '独立密钥')
                }
                busy={
                  toggle.isPending ||
                  resetQuota.isPending ||
                  reveal.isPending ||
                  rotate.isPending ||
                  remove.isPending
                }
                onView={() => void viewPlain(k)}
                onCopy={() => void copyPlain(k)}
                onRotate={() => setRotateId(k.id)}
                onEdit={() => setEditId(k.id)}
                onDetails={() => setDetails(k)}
                onStats={() => setStatsId(k.id)}
                onToggle={() =>
                  toggle.mutate({ id: k.id, enable: k.status === 'disabled' })
                }
                onReset={() => setResetId(k.id)}
                onDelete={() => setDelId(k.id)}
              />
            ))}
          </div>
        )}
      </QueryGate>
      <Sheet
        open={!!details}
        onOpenChange={(open) => {
          if (!open) setDetails(null)
        }}
      >
        <SheetContent className='overflow-y-auto'>
          <SheetHeader>
            <SheetTitle>{details?.name || '密钥详情'}</SheetTitle>
            <SheetDescription>
              密钥自身的限制叠加在订阅限制之上，不能扩大订阅额度。
            </SheetDescription>
          </SheetHeader>
          {details && (
            <div className='space-y-5 px-4 text-sm'>
              <code>{maskApiKeyItem(details)}</code>
              <div>
                <p>请求限额：{keyQuotaLabel(details)}</p>
                {keyQuotaPct(details) != null && (
                  <Progress
                    className='mt-2 h-1.5'
                    value={keyQuotaPct(details) || 0}
                  />
                )}
              </div>
              <p>
                金额限额：
                {details.quota_usd
                  ? usageMoney(details.quota_usd)
                  : '未单独限制'}{' '}
                · 已计 {usageMoney(details.quota_usd_used || 0)}
              </p>
              <p>
                并发：{details.max_concurrency || '未单独限制'} · RPM：
                {details.rpm || '未单独限制'}
              </p>
              <p>
                有效期：
                {details.expires_at
                  ? new Date(details.expires_at).toLocaleString('zh-CN')
                  : '长期有效'}
              </p>
              <Button
                onClick={() => {
                  setEditId(details.id)
                  setDetails(null)
                }}
              >
                编辑限制
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
      <ConfirmDialog
        open={!!resetId}
        onOpenChange={(open) => {
          if (!open) setResetId('')
        }}
        title='重置密钥限额计数'
        desc='只重置此密钥自身的请求和金额限额计数；不会恢复订阅额度，也不会删除历史用量。'
        confirmText='确认重置'
        isLoading={resetQuota.isPending}
        handleConfirm={() => resetQuota.mutate(resetId)}
      />
      <KeyLimitsDialog
        mode='create'
        open={createOpen}
        onOpenChange={setCreateOpen}
        pending={create.isPending}
        vms={vmItems}
        pools={isAdmin ? pools.data?.pools || [] : undefined}
        onSubmit={(draft) => create.mutate(draft)}
      />
      <KeyLimitsDialog
        mode='edit'
        open={!!editId}
        onOpenChange={(open) => {
          if (!open) setEditId('')
        }}
        initial={editing}
        vms={vmItems}
        pools={isAdmin ? pools.data?.pools || [] : undefined}
        pending={edit.isPending}
        onSubmit={(draft) => {
          if (!editId) return
          edit.mutate({ id: editId, draft })
        }}
      />
      <KeyRevealDialog value={revealed} onClose={() => setRevealed(null)} />
      <KeyStatsDialog
        item={keys.find((k) => k.id === statsId) || null}
        vms={vmItems}
        onOpenChange={(open) => {
          if (!open) setStatsId('')
        }}
      />
      <ConfirmDialog
        open={!!rotateId}
        onOpenChange={() => setRotateId('')}
        title='换新密钥'
        desc={`${rotating?.name || rotateId} · 换新后旧密钥立即失效，请同步更新客户端配置；名称、限制和历史统计保留。`}
        confirmText='换新'
        cancelBtnText='取消'
        isLoading={rotate.isPending}
        handleConfirm={() => {
          if (rotateId) rotate.mutate(rotateId)
        }}
      />
      <ConfirmDialog
        open={!!delId}
        onOpenChange={() => setDelId('')}
        title='删除密钥'
        desc='删除后立即失效，客户端再用该 key 将收到 401。'
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (delId) remove.mutate(delId)
        }}
      />
    </PageHeader>
  )
}

function draftName(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const rec = payload as Record<string, unknown>
  if (typeof rec.name === 'string') return rec.name
  const item = rec.item
  if (item && typeof item === 'object') {
    const name = (item as Record<string, unknown>).name
    if (typeof name === 'string') return name
  }
  return undefined
}

function KeyRow({
  item,
  usage,
  ready,
  range,
  planName,
  busy,
  onView,
  onCopy,
  onRotate,
  onEdit,
  onDetails,
  onStats,
  onToggle,
  onReset,
  onDelete,
}: {
  item: ApiKeyItem
  usage?: KeyUsage
  ready: boolean
  range: UsageSearch
  planName: string
  busy: boolean
  onView: () => void
  onCopy: () => void
  onRotate: () => void
  onEdit: () => void
  onDetails: () => void
  onStats: () => void
  onToggle: () => void
  onReset: () => void
  onDelete: () => void
}) {
  const metric = (value: string) => (ready ? value : '—')
  return (
    <article
      aria-label={item.name || item.id}
      className={cn(
        'grid grid-cols-2 items-center gap-3 rounded-xl border bg-card p-4 xl:grid-cols-[minmax(170px,2fr)_80px_80px_90px_110px_minmax(130px,1fr)_190px] xl:rounded-none xl:border-0 xl:border-b xl:last:border-b-0',
        keyIsDead(item) && 'bg-muted/20'
      )}
    >
      <div className='min-w-0'>
        <p className='truncate font-semibold' title={item.name}>
          {item.name || '未命名密钥'}
        </p>
        <p className='truncate text-xs text-muted-foreground'>{planName}</p>
        <p className='text-xs text-muted-foreground'>{scopeText(item)}</p>
        <code className='text-xs text-muted-foreground'>
          {maskApiKeyItem(item)}
        </code>
      </div>
      <div className='justify-self-end xl:justify-self-start'>
        <StatusMark tone={keyStatusTone(item)} />
      </div>
      <div className='text-sm tabular-nums'>
        <span className='block text-xs text-muted-foreground xl:hidden'>
          请求数
        </span>
        {metric(fmtNum(usage?.requests || 0))}
      </div>
      <div className='text-sm tabular-nums'>
        <span className='block text-xs text-muted-foreground xl:hidden'>
          Token
        </span>
        {metric(fmtNum(usageTokens(usage)))}
      </div>
      <div className='text-sm font-medium tabular-nums'>
        <span className='block text-xs font-normal text-muted-foreground xl:hidden'>
          额度消耗
        </span>
        {metric(usageMoney(usage?.actual_cost || 0))}
      </div>
      <div className='text-xs text-muted-foreground'>
        <span className='block xl:hidden'>范围内最近调用</span>
        {metric(
          usage?.last_used_at
            ? new Date(usage.last_used_at).toLocaleString('zh-CN')
            : '暂无调用'
        )}
      </div>
      <div className='col-span-2 flex flex-wrap justify-end gap-1 border-t pt-3 xl:col-span-1 xl:border-0 xl:pt-0'>
        {item.revealable && (
          <Button size='sm' variant='ghost' disabled={busy} onClick={onCopy}>
            复制
          </Button>
        )}
        <Button size='sm' variant='outline' asChild>
          <Link to='/usage-records' search={{ ...range, api_key_id: item.id }}>
            查看用量
          </Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size='sm'
              variant='ghost'
              disabled={busy}
              aria-label='更多操作'
            >
              ···
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end'>
            <DropdownMenuItem onSelect={onStats}>统计</DropdownMenuItem>
            <DropdownMenuItem onSelect={onDetails}>详情与限制</DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>编辑限制</DropdownMenuItem>
            {item.revealable && (
              <DropdownMenuItem onSelect={onView}>查看密钥</DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onToggle}>
              {item.status === 'disabled' ? '启用' : '停用'}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRotate}>换新密钥</DropdownMenuItem>
            <DropdownMenuItem onSelect={onReset}>重置限额计数</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className='text-destructive' onSelect={onDelete}>
              删除密钥
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  )
}

function scopeText(item: ApiKeyItem): string {
  if (item.vm_pool_id) return `账号池 · ${item.vm_pool_name || item.vm_pool_id}`
  if (item.group_type === 'anthropic')
    return `Anthropic · ${item.allowed_vms?.length || 0} 台`
  if (item.group_type === 'openai')
    return `OpenAI · ${item.allowed_vms?.length || 0} 台`
  return '按账户 / 订阅授权'
}
