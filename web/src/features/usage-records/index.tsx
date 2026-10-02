import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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
import { fmtNum, fmtUsd } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { StatCard } from '@/components/stat-card'
import type { Plan } from '@/features/subscriptions'

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
  items: Row[]
  total: number
  page_size: number
  totals: Totals
  trend: (Totals & { day: string })[]
  models: (Totals & { model: string })[]
}
const selectClass = 'h-9 rounded-md border bg-background px-3 text-sm'
function localDate(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400000)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 10)
}

export function UsageRecordsPage() {
  const me = useAuthStore((s) => s.me)
  const admin = me?.role === 'admin'
  const [from, setFrom] = useState(localDate(6))
  const [until, setUntil] = useState(localDate())
  const [user, setUser] = useState('')
  const [group, setGroup] = useState('')
  const [key, setKey] = useState('')
  const [vm, setVm] = useState('')
  const [model, setModel] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
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
  const t = q.data?.totals
  const change =
    (fn: (value: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      fn(e.target.value)
      setPage(1)
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
      ...(q.data?.items || []).map((r) =>
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
          <Button variant='outline' onClick={() => void q.refetch()}>
            <RefreshCw className='size-4' />
            刷新
          </Button>
          <Button
            variant='outline'
            disabled={!q.data?.items.length}
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
      <div className='mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard
          label='总请求数'
          value={fmtNum(t?.requests || 0)}
          hint={`成功 ${fmtNum(t?.success || 0)}`}
        />
        <StatCard
          label='总 Token'
          value={fmtNum(
            (t?.input_tokens || 0) +
              (t?.output_tokens || 0) +
              (t?.cache_read_tokens || 0) +
              (t?.cache_creation_tokens || 0)
          )}
          hint={`输入 ${fmtNum(t?.input_tokens || 0)} · 输出 ${fmtNum(t?.output_tokens || 0)} · 缓存 ${fmtNum((t?.cache_read_tokens || 0) + (t?.cache_creation_tokens || 0))}`}
        />
        <StatCard
          label='额度消耗'
          value={fmtUsd(t?.actual_cost || 0)}
          hint={`参考费用 ${fmtUsd(t?.reference_cost || 0)}`}
        />
        <StatCard
          label='平均耗时'
          value={`${((t?.duration_ms || 0) / 1000).toFixed(2)}s`}
        />
      </div>
      <div className='mb-6 flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4'>
        <label className='grid gap-1 text-xs text-muted-foreground'>
          开始日期
          <Input type='date' value={from} onChange={change(setFrom)} />
        </label>
        <label className='grid gap-1 text-xs text-muted-foreground'>
          结束日期
          <Input type='date' value={until} onChange={change(setUntil)} />
        </label>
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
      {q.error && (
        <p role='alert' className='mb-4 text-destructive'>
          {q.error.message}
        </p>
      )}
      <div className='mb-6 grid gap-4 xl:grid-cols-3'>
        <div className='rounded-xl border bg-card p-5 xl:col-span-2'>
          <h3 className='mb-4 font-semibold'>
            额度消耗趋势{' '}
            <span className='text-xs font-normal text-muted-foreground'>
              按日 · 北京时间
            </span>
          </h3>
          {q.data?.trend.length ? (
            <ResponsiveContainer width='100%' height={220}>
              <AreaChart data={q.data.trend}>
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
          {q.data?.models.map((m) => (
            <div
              key={m.model || 'unknown'}
              className='border-b py-3 text-sm last:border-0'
            >
              <div className='mb-1 flex justify-between gap-2'>
                <span className='truncate'>{m.model || '未识别'}</span>
                <span>{fmtUsd(m.actual_cost)}</span>
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
            {q.data?.items.map((r) => (
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
                  {r.actual_cost == null ? '待计价' : fmtUsd(r.actual_cost)}
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
        {!q.data?.items.length && (
          <p className='p-12 text-center text-muted-foreground'>
            {q.isLoading ? '正在加载…' : '所选范围没有使用记录'}
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
            {detail.total_cost == null ? '待计价' : fmtUsd(detail.total_cost)} ·
            缓存读取：{fmtNum(detail.cache_read_tokens)} · 缓存写入：
            {fmtNum(detail.cache_creation_tokens)} · 首字耗时：
            {detail.first_token_ms == null ? '—' : `${detail.first_token_ms}ms`}
          </p>
        </div>
      )}
      <div className='mt-4 flex items-center justify-between text-sm text-muted-foreground'>
        <span>
          共 {q.data?.total || 0} 条 · 第 {page} 页
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
            disabled={q.isFetching || page * 25 >= (q.data?.total || 0)}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </div>
      </div>
    </PageHeader>
  )
}
