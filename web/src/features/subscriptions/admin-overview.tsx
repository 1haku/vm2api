import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/stat-card'
import type { Subscription } from './index'

type Usage = {
  requests: number
  tokens: number
  cost: number
  errors: number
  last_call: string | null
}
export type Overview = {
  users: (Usage & { user_id: string })[]
  subscriptions: Subscription[]
  slots: (Usage & {
    vm_id: string
    name: string
    status: string
    has_token: boolean
    schedulable: boolean
    plan_name: string | null
    subscribed_users: number
    active_users: number
    inflight: number
    max_concurrency: number
  })[]
}
export const overviewQuery = (days = 1) => ({
  queryKey: ['subscription-overview', days],
  queryFn: () =>
    api<Overview>(`/api/panel/subscriptions/admin-overview?days=${days}`),
  refetchInterval: 30000,
})

export function SlotLoadPanel() {
  const [days, setDays] = useState(1)
  const [sort, setSort] = useState('requests')
  const q = useQuery(overviewQuery(days))
  const items = [...(q.data?.slots || [])].sort((a, b) =>
    sort === 'cost'
      ? b.cost - a.cost
      : sort === 'errors'
        ? b.errors / Math.max(1, b.requests) -
          a.errors / Math.max(1, a.requests)
        : b.requests - a.requests
  )
  return (
    <section className='space-y-4' aria-label='槽位负载'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='flex gap-2'>
          {[1, 7, 30].map((n) => (
            <Button
              key={n}
              size='sm'
              variant={days === n ? 'default' : 'outline'}
              onClick={() => setDays(n)}
            >
              {n === 1 ? '今天' : `近 ${n} 天`}
            </Button>
          ))}
        </div>
        <select
          aria-label='负载排序'
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className='h-9 rounded-md border bg-background px-3 text-sm'
        >
          <option value='requests'>按请求数</option>
          <option value='cost'>按费用</option>
          <option value='errors'>按失败率</option>
        </select>
      </div>
      <p className='text-xs text-muted-foreground'>
        统计时区：上海。已分配人数和当前占用为实时状态，用量按所选时间范围汇总。当前占用指网关执行席位，费用不代表上游套餐剩余额度。
      </p>
      {q.isLoading && <p>正在加载负载…</p>}
      {q.error && (
        <p role='alert' className='text-destructive'>
          负载加载失败：{q.error.message}{' '}
          <Button variant='link' onClick={() => void q.refetch()}>
            重试
          </Button>
        </p>
      )}
      {q.data && !q.error && (
        <>
          <div className='grid gap-3 sm:grid-cols-3'>
            <StatCard label='账号槽位' value={String(items.length)} />
            <StatCard
              label='所选范围请求'
              value={items.reduce((n, s) => n + s.requests, 0).toLocaleString()}
            />
            <StatCard
              label='所选范围费用'
              value={fmtUsd(items.reduce((n, s) => n + s.cost, 0))}
            />
          </div>
          <div className='overflow-x-auto rounded-xl border bg-card'>
            <table className='w-full text-left text-sm'>
              <thead className='bg-muted/40'>
                <tr>
                  {[
                    '槽位 / 方案',
                    '调用条件',
                    '分配 / 活跃用户',
                    '席位占用',
                    '请求 / Token',
                    '费用',
                    '失败率',
                    '',
                  ].map((h, i) => (
                    <th key={i} className='p-4 whitespace-nowrap'>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.vm_id} className='border-t'>
                    <td className='p-4 font-medium'>
                      {s.name}
                      <span className='mt-1 block text-xs text-muted-foreground'>
                        {s.plan_name || '未绑定订阅'}
                      </span>
                    </td>
                    <td className='p-4 whitespace-nowrap'>
                      {!s.has_token
                        ? '待登录'
                        : s.status !== 'running'
                          ? '未运行'
                          : s.schedulable === false
                            ? '未开放'
                            : '已配置'}
                    </td>
                    <td className='p-4 tabular-nums'>
                      {s.subscribed_users} / {s.active_users}
                    </td>
                    <td className='p-4 tabular-nums'>
                      {s.inflight} 席
                      <span className='block text-xs text-muted-foreground'>
                        并发配置 {s.max_concurrency}
                      </span>
                    </td>
                    <td className='p-4 tabular-nums'>
                      {s.requests.toLocaleString()}
                      <span className='block text-xs text-muted-foreground'>
                        {s.tokens.toLocaleString()} Token
                      </span>
                    </td>
                    <td className='p-4 tabular-nums'>{fmtUsd(s.cost)}</td>
                    <td className='p-4 tabular-nums'>
                      {s.requests
                        ? `${((100 * s.errors) / s.requests).toFixed(1)}%`
                        : '—'}
                    </td>
                    <td className='p-4 whitespace-nowrap'>
                      <Link
                        className='text-primary hover:underline'
                        to='/usage-records'
                        search={{
                          vm_id: s.vm_id,
                          range:
                            days === 1 ? 'today' : days === 7 ? '7d' : '30d',
                        }}
                      >
                        使用明细 →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!items.length && (
              <p className='p-8 text-center text-muted-foreground'>
                暂无账号槽位
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}
