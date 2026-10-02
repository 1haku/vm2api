import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Activity,
  ArrowRight,
  CreditCard,
  KeyRound,
  Users,
  AlertCircle,
  Server,
} from 'lucide-react'
import { fmtNum } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { overviewQuery } from '@/features/subscriptions/admin-overview'
import { SubscriptionWizard } from '@/features/subscriptions/wizard'
import { usageMoney } from '@/features/usage-records/filters'

export function WorkspaceSummary() {
  const [assignOpen, setAssignOpen] = useState(false)
  const q = useQuery(overviewQuery())
  const data = q.data
  const active = (data?.subscriptions || []).filter(
    (s) =>
      s.status === 'active' &&
      s.plan_status === 'active' &&
      Date.parse(s.expires_at) > Date.now()
  )
  const due = active.filter(
    (s) => Date.parse(s.expires_at) <= Date.now() + 7 * 86400000
  ).length
  const missing = (data?.slots || []).filter((s) => !s.has_token).length
  const requests = (data?.users || []).reduce((sum, u) => sum + u.requests, 0)
  const cost = (data?.users || []).reduce((sum, u) => sum + u.cost, 0)
  const metrics = [
    {
      label: '生效订阅',
      value: active.length,
      hint: `${new Set(active.map((s) => s.user_id)).size} 位订阅用户`,
      icon: CreditCard,
    },
    {
      label: '今日请求',
      value: fmtNum(requests),
      hint: '所有用户累计请求',
      icon: Activity,
    },
    {
      label: '今日消费',
      value: usageMoney(cost),
      hint: '按实际计费金额汇总',
      icon: KeyRound,
    },
    {
      label: '即将到期',
      value: due,
      hint: '未来 7 天内到期的订阅',
      icon: Users,
    },
  ]
  return (
    <section className='mb-8 space-y-5' aria-label='订阅工作台'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <h2 className='text-base font-semibold'>订阅概况</h2>
        <Button onClick={() => setAssignOpen(true)}>
          <CreditCard className='size-4' />
          分配订阅
        </Button>
      </div>
      {q.error && (
        <div
          role='alert'
          className='flex flex-wrap items-center gap-3 rounded-xl border border-destructive/20 p-4 text-sm text-destructive'
        >
          订阅统计读取失败：{q.error.message}
          <Button variant='outline' size='sm' onClick={() => q.refetch()}>
            重试
          </Button>
        </div>
      )}
      <div className='grid grid-cols-2 gap-3 xl:grid-cols-4'>
        {metrics.map(({ label, value, hint, icon: Icon }) => (
          <div key={label} className='rounded-xl border bg-card p-4 sm:p-5'>
            <div className='flex items-center justify-between gap-2'>
              <p className='text-sm text-muted-foreground'>{label}</p>
              <Icon className='size-4 text-primary/70' />
            </div>
            <p className='mt-4 text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl'>
              {!data ? '—' : value}
            </p>
            <p className='mt-2 text-xs leading-5 text-muted-foreground'>
              {!data ? (q.isLoading ? '正在加载…' : '暂时无法读取') : hint}
            </p>
          </div>
        ))}
      </div>
      <div className='grid gap-3 sm:grid-cols-3'>
        {[
          {
            to: '/users' as const,
            label: '用户管理',
            description: '分配订阅与调整个人额度',
            icon: Users,
          },
          {
            to: '/usage-records' as const,
            label: '使用明细',
            description: '按用户、密钥追踪每次请求',
            icon: Activity,
          },
          {
            to: '/vm' as const,
            label: '账号槽位',
            description: '管理账号凭证与运行状态',
            icon: Server,
          },
        ].map(({ to, label, description, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className='group flex items-center gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          >
            <span className='grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-primary'>
              <Icon className='size-5' />
            </span>
            <div className='min-w-0 flex-1'>
              <p className='text-sm font-medium'>{label}</p>
              <p className='mt-1 text-xs leading-5 text-muted-foreground'>
                {description}
              </p>
            </div>
            <ArrowRight className='size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5' />
          </Link>
        ))}
      </div>
      {!!missing && (
        <div className='flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm'>
          <AlertCircle className='size-4 shrink-0 text-amber-600 dark:text-amber-400' />
          <p className='flex-1 leading-6'>
            {missing} 个槽位尚未配置凭证，关联订阅暂时无法使用这些账号。
          </p>
          <Link
            to='/import'
            className='inline-flex items-center gap-1 font-medium text-primary'
          >
            配置凭证
            <ArrowRight className='size-3.5' />
          </Link>
        </div>
      )}
      {assignOpen && (
        <SubscriptionWizard onClose={() => setAssignOpen(false)} />
      )}
    </section>
  )
}
