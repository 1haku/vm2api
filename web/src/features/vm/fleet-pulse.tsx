import { useMemo } from 'react'
import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import { fmtNum, fmtUsd, usedPctOf } from '@/lib/format'
import { cn } from '@/lib/utils'
import { fleetGroup, type FleetGroup } from '@/lib/vm-status'
import { vmTodayStats, vmWeekOutcome } from '@/lib/vm-usage'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

/**
 * 舰队构成的六个分组，顺序即「可用性降序」：能打的在左，废的在右。
 *
 * `revoke` 用 red 而不是 pink：它和 `bad` 在筛选上是两档，堆叠条上挨着，
 * 同色相会糊成一段。red/pink 是主题里唯二的相邻红相，拿来做这组区分正好。
 * `off`（运维主动关）与 `none`（没绑凭证）都走中性灰，靠 alpha 分层——
 * 它们不是故障，不该占红色。
 */
const GROUPS: { key: FleetGroup; label: string; color: string }[] = [
  { key: 'pool', label: '在池', color: 'var(--status-ok-solid)' },
  { key: 'restricted', label: '受限', color: 'var(--status-warn-solid)' },
  { key: 'off', label: '关闭调用', color: 'var(--status-none)' },
  {
    key: 'none',
    label: '未使用',
    color: 'color-mix(in oklch, var(--status-none) 55%, transparent)',
  },
  { key: 'bad', label: '无效凭证', color: 'var(--status-bad-solid)' },
  { key: 'revoke', label: '已吊销', color: 'var(--red-4)' },
]

/** 7d 余量直方图的档位。越靠左越危险，和用量条的风险轴同向。 */
const HEADROOM_BUCKETS: { label: string; color: string }[] = [
  { label: '0', color: 'var(--status-bad-solid)' },
  { label: '20', color: 'var(--status-warn-solid)' },
  { label: '40', color: 'var(--status-caution-solid)' },
  { label: '60', color: 'var(--status-ok-solid)' },
  { label: '80', color: 'var(--status-ok-solid)' },
]

type Pulse = {
  total: number
  counts: Record<FleetGroup, number>
  /** 有票槽位的 7d 余量，按 20% 一档分桶。 */
  headroom: number[]
  headroomMedian: number | null
  todayCost: number
  todayReq: number
  todayTok: number
  weekCost: number
  /** 今日花得最多的槽位，null 表示全队今天都没花钱。 */
  topBurner: { name: string; cost: number } | null
  weekKnown: boolean
  weekSuccess: number
  weekFail: number
}

function computePulse(vms: Vm[], accounts?: UsageAccountRow[]): Pulse {
  const counts: Record<FleetGroup, number> = {
    pool: 0,
    restricted: 0,
    off: 0,
    none: 0,
    bad: 0,
    revoke: 0,
  }
  const headroom = [0, 0, 0, 0, 0]
  const remains: number[] = []
  let todayCost = 0
  let todayReq = 0
  let todayTok = 0
  let weekCost = 0
  let weekSuccess = 0
  let weekFail = 0
  let weekKnown = false
  let topBurner: { name: string; cost: number } | null = null

  for (const vm of vms) {
    counts[fleetGroup(vm)] += 1
    if (vm.has_token) {
      const remain = Math.max(0, 100 - usedPctOf(vm, '7d'))
      remains.push(remain)
      headroom[Math.min(4, Math.floor(remain / 20))] += 1
    }
    const today = vmTodayStats(vm, accounts)
    todayCost += today.today
    todayReq += today.req
    todayTok += today.tok
    if (today.today > 0 && today.today > (topBurner?.cost ?? 0)) {
      topBurner = { name: vm.name || vm.id, cost: today.today }
    }
    const week = vmWeekOutcome(vm, accounts)
    weekCost += week.cost
    if (week.known) {
      weekKnown = true
      weekSuccess += week.success
      weekFail += week.fail
    }
  }

  remains.sort((a, b) => a - b)
  const mid = remains.length >> 1
  const headroomMedian = !remains.length
    ? null
    : remains.length % 2
      ? remains[mid]
      : (remains[mid - 1] + remains[mid]) / 2

  return {
    total: vms.length,
    counts,
    headroom,
    headroomMedian,
    todayCost,
    todayReq,
    todayTok,
    weekCost,
    topBurner,
    weekKnown,
    weekSuccess,
    weekFail,
  }
}

function Cell({
  title,
  meta,
  className,
  children,
}: {
  title: string
  meta?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn('flex min-w-0 flex-col gap-2.5 bg-card p-3.5', className)}
    >
      <div className='flex items-baseline justify-between gap-2'>
        <h3 className='text-[11.5px] font-medium tracking-wide text-muted-foreground'>
          {title}
        </h3>
        {meta}
      </div>
      {children}
    </div>
  )
}

/**
 * 舰队脉搏。列表上方的四格总览，回答运维打开这一页时的四个问题：
 * 现在有多少能打（构成）· 还剩多少余量（余量分布）· 今天烧了多少（消耗）
 * · 打出去的成了没有（成败）。
 *
 * 构成条的分段同时是筛选入口 —— 不另起一排按钮，图例即控件：
 * 比例给「多不多」，数字给「多少」，点击给「只看这档」。
 */
export function FleetPulse({
  vms,
  accounts,
  filter,
  onFilter,
  className,
}: {
  /** 已按凭证面（Claude / GPT）筛过、但未经搜索与分组筛选的全集。 */
  vms: Vm[]
  accounts?: UsageAccountRow[]
  filter: string
  onFilter: (next: string) => void
  className?: string
}) {
  const pulse = useMemo(() => computePulse(vms, accounts), [vms, accounts])
  const segments = GROUPS.filter((g) => pulse.counts[g.key] > 0)
  const focused = filter !== 'all'
  const headroomMax = Math.max(...pulse.headroom, 1)
  const weekTotal = pulse.weekSuccess + pulse.weekFail
  const weekRate = weekTotal > 0 ? (pulse.weekSuccess / weekTotal) * 100 : null

  return (
    <div
      className={cn(
        'grid gap-px overflow-hidden rounded-xl border bg-border/60 sm:grid-cols-2 xl:grid-cols-12',
        className
      )}
    >
      <Cell
        title='舰队构成'
        className='xl:col-span-4'
        meta={
          <span className='text-[13px] leading-none font-[590] tracking-[-0.01em] tabular-nums'>
            <span className='text-[color:var(--status-ok)]'>
              {pulse.counts.pool}
            </span>
            <span className='text-muted-foreground'> / {pulse.total} 在池</span>
          </span>
        }
      >
        <div className='flex h-2.5 w-full gap-px overflow-hidden rounded-full track-recessed'>
          {segments.map((g) => (
            <Tooltip key={g.key}>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  aria-label={`${g.label} ${pulse.counts[g.key]} 台`}
                  aria-pressed={filter === g.key}
                  onClick={() => onFilter(filter === g.key ? 'all' : g.key)}
                  className={cn(
                    'h-full min-w-[3px] motion-safe:transition-[flex-grow,opacity] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]',
                    focused && filter !== g.key && 'opacity-25'
                  )}
                  style={{
                    flexGrow: pulse.counts[g.key],
                    flexBasis: 0,
                    backgroundColor: g.color,
                  }}
                />
              </TooltipTrigger>
              <TooltipContent>
                {g.label} {pulse.counts[g.key]} 台
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className='-mx-1 flex flex-wrap items-center gap-x-0.5 gap-y-0.5'>
          <button
            type='button'
            aria-pressed={filter === 'all'}
            onClick={() => onFilter('all')}
            className={cn(
              'rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent/60',
              filter === 'all'
                ? 'font-medium text-foreground'
                : 'text-muted-foreground'
            )}
          >
            全部 <span className='font-medium tabular-nums'>{pulse.total}</span>
          </button>
          {GROUPS.map((g) => (
            <button
              key={g.key}
              type='button'
              aria-pressed={filter === g.key}
              onClick={() => onFilter(filter === g.key ? 'all' : g.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent/60',
                filter === g.key
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground',
                !pulse.counts[g.key] && 'opacity-45'
              )}
            >
              <span
                className='size-2 shrink-0 rounded-[3px]'
                style={{ backgroundColor: g.color }}
                aria-hidden='true'
              />
              {g.label}
              <span className='font-medium tabular-nums'>
                {pulse.counts[g.key]}
              </span>
            </button>
          ))}
        </div>
      </Cell>

      <Cell
        title='7d 余量分布'
        className='xl:col-span-3'
        meta={
          <span className='text-[13px] leading-none font-[590] tracking-[-0.01em] tabular-nums'>
            {pulse.headroomMedian == null ? (
              <span className='text-muted-foreground'>—</span>
            ) : (
              <>
                {pulse.headroomMedian.toFixed(0)}%
                <span className='text-muted-foreground'> 中位</span>
              </>
            )}
          </span>
        }
      >
        <div className='flex h-[46px] items-end gap-1.5'>
          {HEADROOM_BUCKETS.map((bucket, i) => (
            <Tooltip key={bucket.label}>
              <TooltipTrigger asChild>
                <button
                  type='button'
                  aria-label={`余量 ${bucket.label}–${Number(bucket.label) + 20}% ${pulse.headroom[i]} 台`}
                  className='flex h-full flex-1 cursor-default flex-col justify-end gap-1'
                >
                  <span className='text-center text-[10px] leading-none text-muted-foreground tabular-nums'>
                    {pulse.headroom[i] || ''}
                  </span>
                  <span
                    className='w-full rounded-[3px] motion-safe:transition-[height] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]'
                    style={{
                      height: pulse.headroom[i]
                        ? `${Math.max(8, (pulse.headroom[i] / headroomMax) * 100)}%`
                        : '2px',
                      backgroundColor: pulse.headroom[i]
                        ? bucket.color
                        : 'var(--track)',
                    }}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                余量 {bucket.label}–{Number(bucket.label) + 20}% ·{' '}
                {pulse.headroom[i]} 台
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className='flex justify-between font-mono text-[10px] leading-none text-muted-foreground tabular-nums'>
          {HEADROOM_BUCKETS.map((bucket) => (
            <span key={bucket.label} className='flex-1 text-center'>
              {bucket.label}
            </span>
          ))}
        </div>
      </Cell>

      <Cell
        title='今日消耗'
        className='xl:col-span-3'
        meta={
          <span className='text-[11px] text-muted-foreground tabular-nums'>
            7d {fmtUsd(pulse.weekCost, 2)}
          </span>
        }
      >
        <div className='text-[26px] leading-none font-[590] tracking-[-0.02em] tabular-nums'>
          {fmtUsd(pulse.todayCost, 2)}
        </div>
        <div className='flex flex-col gap-1'>
          <div className='font-mono text-[11px] text-muted-foreground tabular-nums'>
            {fmtNum(pulse.todayReq)} req · {fmtNum(pulse.todayTok)} tok
          </div>
          {pulse.topBurner ? (
            <div className='truncate text-[11px] text-muted-foreground'>
              最高{' '}
              <span className='text-foreground'>{pulse.topBurner.name}</span>{' '}
              <span className='tabular-nums'>
                {fmtUsd(pulse.topBurner.cost, 2)}
              </span>
            </div>
          ) : null}
        </div>
      </Cell>

      <Cell
        title='7D 成败'
        className='xl:col-span-2'
        meta={
          <span className='text-[11px] text-muted-foreground tabular-nums'>
            {weekTotal > 0 ? `${fmtNum(weekTotal)} 次` : ''}
          </span>
        }
      >
        <div
          className={cn(
            'text-[26px] leading-none font-[590] tracking-[-0.02em] tabular-nums',
            weekRate == null
              ? 'text-muted-foreground'
              : weekRate >= 95
                ? 'text-[color:var(--status-ok)]'
                : weekRate >= 80
                  ? 'text-[color:var(--status-caution)]'
                  : 'text-[color:var(--status-bad)]'
          )}
        >
          {weekRate == null ? '—' : `${weekRate.toFixed(1)}%`}
        </div>
        <div className='flex flex-col gap-1.5'>
          <div className='flex h-1.5 w-full gap-px overflow-hidden rounded-full track-recessed'>
            {weekTotal > 0 ? (
              <>
                <span
                  className='h-full motion-safe:transition-[flex-grow] motion-safe:duration-500'
                  style={{
                    flexGrow: pulse.weekSuccess,
                    flexBasis: 0,
                    backgroundColor: 'var(--status-ok-solid)',
                  }}
                />
                {pulse.weekFail > 0 ? (
                  <span
                    className='h-full min-w-[3px]'
                    style={{
                      flexGrow: pulse.weekFail,
                      flexBasis: 0,
                      backgroundColor: 'var(--status-bad-solid)',
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </div>
          <div className='font-mono text-[11px] text-muted-foreground tabular-nums'>
            {pulse.weekKnown
              ? `${fmtNum(pulse.weekSuccess)} 成 · ${fmtNum(pulse.weekFail)} 败`
              : '网关未上报成败'}
          </div>
        </div>
      </Cell>
    </div>
  )
}
