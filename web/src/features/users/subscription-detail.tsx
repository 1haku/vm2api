import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { PanelUser } from '@/types/panel-users'
import { fmtAgo, fmtUsd } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { StatCard } from '@/components/stat-card'
import type { Overview } from '@/features/subscriptions/admin-overview'
import { BatchActions } from '@/features/subscriptions/batch-actions'

export const subscriptionStatus: Record<string, string> = {
  active: '生效中',
  expired: '已到期',
  suspended: '已暂停',
  revoked: '已撤销',
}
export function UserSubscriptionDetail({
  user,
  data,
  onClose,
  onAssign,
}: {
  user: PanelUser
  data?: Overview
  onClose: () => void
  onAssign: () => void
}) {
  const [selected, setSelected] = useState<string[]>([])
  const subs = data?.subscriptions.filter((s) => s.user_id === user.id) || []
  const usage = data?.users.find((s) => s.user_id === user.id)
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className='w-full overflow-y-auto sm:max-w-2xl'>
        <SheetHeader className='border-b pr-12'>
          <SheetTitle>{user.username} · 用户详情</SheetTitle>
          <SheetDescription>
            {user.enabled === false ? '已停用' : '启用中'} · 最近登录{' '}
            {fmtAgo(user.last_login_at) || '从未'} · 自建槽位配额{' '}
            {user.vm_create_quota ?? 0}
          </SheetDescription>
        </SheetHeader>
        <div className='space-y-5 p-4 pt-0'>
          <div className='grid grid-cols-2 gap-3'>
            <StatCard
              label='今日请求'
              value={data ? String(usage?.requests || 0) : '—'}
            />
            <StatCard
              label='今日费用'
              value={data ? fmtUsd(usage?.cost || 0) : '—'}
            />
          </div>
          <div className='flex flex-wrap gap-2'>
            <Button
              onClick={onAssign}
              disabled={user.enabled === false || user.role === 'super'}
            >
              分配订阅
            </Button>
            <Button variant='outline' asChild>
              <Link
                to='/usage-records'
                search={{ user_id: user.id, range: 'today' }}
              >
                查看使用明细与各 Key 用量
              </Link>
            </Button>
          </div>
          <div className='flex items-center justify-between'>
            <h3 className='font-medium'>订阅与个人额度</h3>
            <span className='text-xs text-muted-foreground'>
              每日额度按上海时区重置
            </span>
          </div>
          {!data && (
            <p role='alert' className='text-sm text-muted-foreground'>
              订阅汇总暂不可用，请关闭详情后刷新。
            </p>
          )}
          {data && !subs.length && (
            <p className='rounded-lg border border-dashed p-8 text-center text-muted-foreground'>
              尚未分配订阅
            </p>
          )}
          {subs.map((s) => (
            <article key={s.id} className='space-y-3 rounded-xl border p-4'>
              <label className='flex items-start gap-3'>
                <input
                  className='mt-1 size-4 accent-primary'
                  type='checkbox'
                  aria-label={`选择 ${s.plan_name}`}
                  checked={selected.includes(s.id)}
                  onChange={(e) =>
                    setSelected((v) =>
                      e.target.checked
                        ? [...v, s.id]
                        : v.filter((id) => id !== s.id)
                    )
                  }
                />
                <span className='flex-1 font-medium'>
                  {s.plan_name}
                  <span className='mt-1 block text-xs font-normal text-muted-foreground'>
                    到期：{new Date(s.expires_at).toLocaleString('zh-CN')}
                  </span>
                </span>
                <span className='text-xs text-muted-foreground'>
                  {s.plan_status === 'active'
                    ? subscriptionStatus[s.status]
                    : '方案已停用'}
                </span>
              </label>
              {[
                ['每日', s.daily_used, s.daily_limit_usd],
                ['每周', s.weekly_used, s.weekly_limit_usd],
              ].map(([label, used, limit]) => (
                <div key={label}>
                  <div className='mb-1 flex justify-between text-xs'>
                    <span>{label}</span>
                    <span>
                      {fmtUsd(Number(used))} /{' '}
                      {Number(limit) > 0 ? fmtUsd(Number(limit)) : '不限额'}
                    </span>
                  </div>
                  <Progress
                    value={
                      Number(limit) > 0
                        ? Math.min(100, (Number(used) / Number(limit)) * 100)
                        : 0
                    }
                  />
                </div>
              ))}
            </article>
          ))}
          {!!subs.length && (
            <BatchActions
              items={subs.filter((s) => selected.includes(s.id))}
              onDone={() => setSelected([])}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
