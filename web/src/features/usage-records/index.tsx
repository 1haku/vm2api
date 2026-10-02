import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Download, RefreshCw } from 'lucide-react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import type { Plan } from '@/features/subscriptions'
import { DateRange } from './date-range'
import {
  usageDates,
  usageMoney,
  usageTokens,
  type KeyUsage,
  type UsageSearch,
} from './filters'

type Totals = {
  requests: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  actual_cost: number
  reference_cost: number
  duration_ms: number
  success: number
}
type Row = Totals & {
  request_id: string
  created_at: string
  username?: string
  vm_id?: string
  model: string
  status: number
  plan_name: string
  key_name: string
  api_key_id: string
  total_cost: number
  first_token_ms: number
}
type Payload = {
  keys: KeyUsage[]
  items: Row[]
  total: number
  page_size: number
  totals: Totals
  trend: (Totals & { day: string })[]
  models: (Totals & { model: string })[]
}
const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'
export function UsageRecordsPage() {
  const me = useAuthStore((s) => s.me)
  const admin = me?.role === 'admin'
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as UsageSearch
  const { from, until, valid } = usageDates(search)
  const user = search.user_id || '',
    group = search.group_id || '',
    key = search.api_key_id || '',
    vm = search.vm_id || '',
    model = search.model || '',
    status = search.status || ''
  const page = Number(search.page) || 1
  const patch = (value: UsageSearch) =>
    void navigate({
      to: '/usage-records',
      search: { ...search, ...value },
      replace: true,
    })
  const setUser = (v: string) => patch({ user_id: v, page: '1' })
  const setGroup = (v: string) => patch({ group_id: v, page: '1' })
  const setKey = (v: string) => patch({ api_key_id: v, page: '1' })
  const setVm = (v: string) => patch({ vm_id: v, page: '1' })
  const setModel = (v: string) => patch({ model: v, page: '1' })
  const setStatus = (v: string) => patch({ status: v, page: '1' })
  const setPage = (v: number) => patch({ page: String(v) })
  const [showAllKeys, setShowAllKeys] = useState(false)
  const [keySort, setKeySort] = useState('cost')
  const [detail, setDetail] = useState<Row | null>(null)
  const params = new URLSearchParams({
    page: String(page),
    page_size: '25',
    group_id: group,
    api_key_id: key,
    model,
    status,
    ...(admin ? { user_id: user, vm_id: vm } : {}),
  })
  if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString())
  if (until)
    params.set('until', new Date(`${until}T23:59:59.999`).toISOString())
  const q = useQuery({
    enabled: valid,
    queryKey: ['usage-records', me?.user, params.toString()],
    queryFn: () => api<Payload>(`/api/panel/usage-records?${params}`),
  })
  const plans = useQuery({
    queryKey: ['subscription-plans', me?.user],
    queryFn: () => api<{ items: Plan[] }>('/api/panel/subscription-plans'),
  })
  const keys = useQuery({
    queryKey: ['usage-record-keys', me?.user],
    queryFn: () =>
      api<{ keys: { id: string; name: string }[] }>('/api/panel/api-keys'),
  })
  const users = useQuery({
    queryKey: ['subscription-users'],
    queryFn: () =>
      api<{ items: { id: string; username: string }[] }>('/api/panel/users'),
    enabled: admin,
  })
  const vms = useQuery({
    queryKey: ['subscription-vms'],
    queryFn: () =>
      api<{ items: { id: string; name: string }[] }>('/api/panel/vms'),
    enabled: admin,
  })
  const data = valid && !q.isError ? q.data : undefined
  const t = data?.totals
  const keyRows = [...(data?.keys || [])].sort((a, b) =>
    keySort === 'requests'
      ? b.requests - a.requests
      : keySort === 'tokens'
        ? usageTokens(b) - usageTokens(a)
        : b.actual_cost - a.actual_cost
  )
  const keyLabel = (k: KeyUsage) =>
    k.key_name ||
    (k.api_key_id ? `历史密钥 · ${k.api_key_id.slice(0, 8)}` : '未关联密钥')
  const change =
    (fn: (value: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      fn(e.target.value)
    }
  function exportPage() {
    const columns = [
      'created_at',
      ...(admin ? ['username', 'vm_id'] : []),
      'plan_name',
      'key_name',
      'model',
      'status',
      'input_tokens',
      'output_tokens',
      'cache_read_tokens',
      'cache_creation_tokens',
      'actual_cost',
      'duration_ms',
      'request_id',
    ] as (keyof Row)[]
    const escape = (v: unknown) => {
      let s = String(v ?? '')
      if (/^[=+@\-\t\r]/.test(s)) s = "'" + s
      return '"' + s.replace(/"/g, '""') + '"'
    }
    const csv = [
      columns.join(','),
      ...(data?.items || []).map((r) =>
        columns.map((c) => escape(r[c])).join(',')
      ),
    ].join('\r\n')
    const url = URL.createObjectURL(
      new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
    )
    const a = document.createElement('a')
    a.href = url
    a.download = `usage-page-${page}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <PageHeader
      title={admin ? '使用记录' : '我的使用记录'}
      extra={
        <div className='flex gap-2'>
          <Button
            variant='outline'
            disabled={!valid || q.isFetching}
            onClick={() => void q.refetch()}
          >
            <RefreshCw className='size-4' />
            刷新
          </Button>
          <Button
            variant='outline'
            disabled={!data?.items.length}
            onClick={exportPage}
          >
            <Download className='size-4' />
            导出本页
          </Button>
        </div>
      }
    >
      <p className='mb-6 text-sm text-muted-foreground'>
        {admin
          ? '查看所有用户的调用情况，按用户、订阅或槽位定位用量。'
          : '仅展示由你的 API Key 发起的请求，共享槽位的其他用户记录不会显示。'}
      </p>
      <div className='mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4'>
        <StatCard
          compact
          label='总请求数'
          value={t ? fmtNum(t.requests) : '—'}
          hint={`成功 ${fmtNum(t?.success || 0)}`}
        />
        <StatCard
          compact
          label='总 Token'
          value={t ? fmtNum(usageTokens(t)) : '—'}
          hint={`输入 ${fmtNum(t?.input_tokens || 0)} · 输出 ${fmtNum(t?.output_tokens || 0)} · 缓存 ${fmtNum((t?.cache_read_tokens || 0) + (t?.cache_creation_tokens || 0))}`}
        />
        <StatCard
          compact
          label='额度消耗'
          value={t ? usageMoney(t.actual_cost) : '—'}
          hint={`参考费用 ${usageMoney(t?.reference_cost || 0)}`}
        />
        <StatCard
          compact
          label='平均耗时'
          value={t ? `${(t.duration_ms / 1000).toFixed(2)}s` : '—'}
        />
      </div>
      <div className='mb-6 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4'>
        <div className='w-full border-b pb-4'>
          <DateRange
            search={search}
            onChange={(value) => patch({ ...value, page: '1' })}
          />
          <p className='mt-2 text-xs text-muted-foreground'>
            日期按浏览器本地时区筛选；趋势按北京时间分日。统计基于保留的调用记录。
          </p>
        </div>
        {admin && (
          <>
            <select
              aria-label='筛选用户'
              className={selectClass}
              value={user}
              onChange={change(setUser)}
            >
              <option value=''>全部用户</option>
              {users.data?.items.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.username}
                </option>
              ))}
            </select>
            <select
              aria-label='筛选槽位'
              className={selectClass}
              value={vm}
              onChange={change(setVm)}
            >
              <option value=''>全部槽位</option>
              {vms.data?.items.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name || v.id}
                </option>
              ))}
            </select>
          </>
        )}
        <select
          aria-label='筛选订阅'
          className={selectClass}
          value={group}
          onChange={change(setGroup)}
        >
          <option value=''>全部订阅</option>
          {plans.data?.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          aria-label='筛选密钥'
          className={selectClass}
          value={key}
          onChange={change(setKey)}
        >
          <option value=''>全部密钥</option>
          {key && !keys.data?.keys.some((k) => k.id === key) && (
            <option value={key}>所选密钥 · {key.slice(0, 8)}</option>
          )}
          {keys.data?.keys.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name || k.id}
            </option>
          ))}
        </select>
        <Input
          aria-label='筛选模型'
          className='w-48'
          placeholder='模型名称（精确匹配）'
          value={model}
          onChange={change(setModel)}
        />
        <select
          aria-label='筛选结果'
          className={selectClass}
          value={status}
          onChange={change(setStatus)}
        >
          <option value=''>全部结果</option>
          <option value='success'>成功</option>
          <option value='error'>失败</option>
        </select>
      </div>
      <div className='mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground'>
        <span>
          {key
            ? `当前密钥：${keys.data?.keys.find((k) => k.id === key)?.name || key.slice(0, 8)}`
            : '当前显示全部密钥'}
        </span>
        {key && (
          <Button size='sm' variant='ghost' onClick={() => setKey('')}>
            查看全部密钥
          </Button>
        )}
        <Button
          size='sm'
          variant='ghost'
          onClick={() =>
            void navigate({
              to: '/usage-records',
              search: {
                range: search.range,
                from: search.from,
                until: search.until,
              },
              replace: true,
            })
          }
        >
          清除筛选
        </Button>
        {q.isFetching && <span role='status'>正在更新…</span>}
      </div>
      {q.error && (
        <p role='alert' className='mb-4 text-destructive'>
          {q.error.message}
        </p>
      )}
      <section className='mb-6 rounded-xl border bg-card p-4 sm:p-5'>
        <div className='mb-3 flex flex-wrap items-center justify-between gap-3'>
          <div>
            <h2 className='font-semibold'>密钥用量对比</h2>
            <p className='mt-1 text-xs text-muted-foreground'>
              遵循上方时间与筛选条件，点击密钥查看调用明细。
            </p>
          </div>
          <select
            aria-label='密钥用量排序'
            className={selectClass}
            value={keySort}
            onChange={(e) => setKeySort(e.target.value)}
          >
            <option value='cost'>按额度消耗</option>
            <option value='tokens'>按 Token</option>
            <option value='requests'>按请求数</option>
          </select>
        </div>
        <div className='space-y-2'>
          {(showAllKeys ? keyRows : keyRows.slice(0, 8)).map((k) => (
            <div
              key={k.api_key_id || 'unassigned'}
              className='grid grid-cols-2 items-center gap-3 rounded-lg bg-muted/25 p-3 sm:grid-cols-[minmax(130px,1fr)_90px_90px_110px_70px]'
            >
              <div className='min-w-0'>
                {k.api_key_id ? (
                  <button
                    className='max-w-full truncate text-left text-sm font-medium text-primary hover:underline'
                    onClick={() => setKey(k.api_key_id!)}
                  >
                    {keyLabel(k)}
                  </button>
                ) : (
                  <span>{keyLabel(k)}</span>
                )}
                <div className='mt-2 h-1 rounded bg-muted'>
                  <div
                    className='h-1 rounded bg-primary/60'
                    style={{
                      width: `${t?.actual_cost ? Math.min(100, (k.actual_cost / t.actual_cost) * 100) : 0}%`,
                    }}
                  />
                </div>
              </div>
              <p className='text-sm tabular-nums'>
                <span className='block text-xs text-muted-foreground'>
                  请求数
                </span>
                {fmtNum(k.requests)}
              </p>
              <p className='text-sm tabular-nums'>
                <span className='block text-xs text-muted-foreground'>
                  Token
                </span>
                {fmtNum(usageTokens(k))}
              </p>
              <p className='text-sm font-medium tabular-nums'>
                <span className='block text-xs font-normal text-muted-foreground'>
                  额度消耗
                </span>
                {usageMoney(k.actual_cost)}
              </p>
              <p className='text-sm'>
                <span className='block text-xs text-muted-foreground'>
                  失败
                </span>
                {fmtNum(k.requests - k.success)}
              </p>
            </div>
          ))}
          {!keyRows.length && (
            <p className='py-6 text-center text-sm text-muted-foreground'>
              {q.isLoading
                ? '正在加载…'
                : q.error
                  ? '用量加载失败，请重试'
                  : !valid
                    ? '请调整时间范围'
                    : '所选范围暂无密钥用量'}
            </p>
          )}
        </div>
        {keyRows.length > 8 && (
          <Button
            variant='ghost'
            className='mt-3'
            onClick={() => setShowAllKeys(!showAllKeys)}
          >
            {showAllKeys ? '收起' : `查看全部 ${keyRows.length} 个密钥`}
          </Button>
        )}
      </section>
      <div className='mb-6 grid gap-4 xl:grid-cols-3'>
        <div className='rounded-xl border bg-card p-5 xl:col-span-2'>
          <h3 className='mb-4 font-semibold'>
            额度消耗趋势{' '}
            <span className='text-xs font-normal text-muted-foreground'>
              按日 · 北京时间
            </span>
          </h3>
          {data?.trend.length ? (
            <ResponsiveContainer width='100%' height={220}>
              <AreaChart data={data!.trend}>
                <CartesianGrid strokeDasharray='3 3' vertical={false} />
                <XAxis dataKey='day' tick={{ fontSize: 11 }} />
                <YAxis width={55} tick={{ fontSize: 11 }} />
                <Tooltip />
                <Area
                  type='monotone'
                  dataKey='actual_cost'
                  name='额度消耗 USD'
                  stroke='#14b8a6'
                  fill='#14b8a6'
                  fillOpacity={0.15}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className='flex h-52 items-center justify-center text-sm text-muted-foreground'>
              所选范围暂无用量
            </div>
          )}
        </div>
        <div className='rounded-xl border bg-card p-5'>
          <h3 className='mb-4 font-semibold'>模型分布</h3>
          {data?.models.map((m) => (
            <div
              key={m.model || 'unknown'}
              className='border-b py-3 text-sm last:border-0'
            >
              <div className='mb-1 flex justify-between gap-2'>
                <span className='truncate'>{m.model || '未识别'}</span>
                <span>{usageMoney(m.actual_cost)}</span>
              </div>
              <span className='text-xs text-muted-foreground'>
                {fmtNum(m.requests)} 次请求
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className='overflow-x-auto rounded-xl border bg-card'>
        <table className='w-full text-left text-sm'>
          <thead className='border-b bg-muted/40'>
            <tr>
              {[
                '时间',
                ...(admin ? ['用户', '槽位'] : []),
                '订阅 / 密钥',
                '模型',
                'Token（输入 / 输出 / 缓存）',
                '额度消耗',
                '耗时',
                '结果',
              ].map((h) => (
                <th key={h} className='p-3 font-medium whitespace-nowrap'>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data?.items.map((r) => (
              <tr key={r.request_id} className='border-b last:border-0'>
                <td className='p-3 whitespace-nowrap'>
                  <button
                    className='text-primary hover:underline'
                    onClick={() =>
                      setDetail(detail?.request_id === r.request_id ? null : r)
                    }
                  >
                    {new Date(r.created_at).toLocaleString('zh-CN')}
                  </button>
                </td>
                {admin && (
                  <>
                    <td className='p-3'>{r.username || '系统 / 历史'}</td>
                    <td className='p-3'>{r.vm_id || '—'}</td>
                  </>
                )}
                <td className='p-3'>
                  {r.plan_name || '—'}
                  <span className='block text-xs text-muted-foreground'>
                    {r.key_name || '—'}
                  </span>
                </td>
                <td className='p-3 whitespace-nowrap'>{r.model || '—'}</td>
                <td className='p-3 whitespace-nowrap tabular-nums'>
                  {fmtNum(r.input_tokens)} / {fmtNum(r.output_tokens)} /{' '}
                  {fmtNum(
                    (r.cache_read_tokens || 0) + (r.cache_creation_tokens || 0)
                  )}
                </td>
                <td className='p-3'>
                  {r.actual_cost == null ? '待计价' : usageMoney(r.actual_cost)}
                </td>
                <td className='p-3'>{(r.duration_ms / 1000).toFixed(2)}s</td>
                <td className='p-3'>
                  <Badge
                    variant={
                      r.status >= 200 && r.status < 300
                        ? 'secondary'
                        : 'destructive'
                    }
                  >
                    {r.status >= 200 && r.status < 300
                      ? '成功'
                      : r.status || '中断'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data?.items.length && (
          <p className='p-12 text-center text-muted-foreground'>
            {q.isLoading
              ? '正在加载…'
              : q.error
                ? '加载失败，请点击刷新重试'
                : !valid
                  ? '请调整时间范围'
                  : '所选范围没有使用记录'}
          </p>
        )}
      </div>
      {detail && (
        <div className='mt-4 rounded-xl border bg-muted/20 p-4 text-sm'>
          <div className='flex justify-between'>
            <strong>请求明细</strong>
            <Button size='sm' variant='ghost' onClick={() => setDetail(null)}>
              关闭
            </Button>
          </div>
          <p className='break-all'>请求 ID：{detail.request_id}</p>
          <p>
            参考费用：
            {detail.total_cost == null
              ? '待计价'
              : usageMoney(detail.total_cost)}{' '}
            · 缓存读取：{fmtNum(detail.cache_read_tokens)} · 缓存写入：
            {fmtNum(detail.cache_creation_tokens)} · 首字耗时：
            {detail.first_token_ms == null ? '—' : `${detail.first_token_ms}ms`}
          </p>
        </div>
      )}
      <div className='mt-4 flex items-center justify-between text-sm text-muted-foreground'>
        <span>
          共 {data?.total || 0} 条 · 第 {page} 页
        </span>
        <div className='flex gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={page === 1 || q.isFetching}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={q.isFetching || page * 25 >= (data?.total || 0)}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
    </PageHeader>
  )
}
