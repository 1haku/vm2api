import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { logStatsQueryOptions } from '@/features/logs/queries'
import { PanelCard } from '@/features/overview/panel-card'
import {
  fillStatsSeries,
  statsRangeQuery,
  type StatsRange,
} from '@/features/overview/statistics-range'

const RANGES: { id: StatsRange; label: string }[] = [
  { id: 'today', label: '今天' },
  { id: '7days', label: '7 天' },
  { id: '30days', label: '30 天' },
  { id: 'thisMonth', label: '本月' },
]

const REFRESH_MS = 5000

export function StatisticsChartCard({ className }: { className?: string }) {
  const [range, setRange] = useState<StatsRange>('today')
  const [metric, setMetric] = useState<'cost' | 'calls'>('cost')
  const [chartMode, setChartMode] = useState<'overlay' | 'stacked'>('overlay')
  const query = useMemo(() => statsRangeQuery(range), [range])
  const stats = useQuery(
    logStatsQueryOptions(query.since, REFRESH_MS, query.bucket)
  )
  const points = fillStatsSeries(
    stats.data?.buckets,
    query.since,
    query.bucket
  ).map((point) => ({
    ...point,
    success: Math.max(0, point.requests - point.errors),
  }))
  const totalCost = points.reduce((sum, point) => sum + point.cost, 0)
  const totalCalls = points.reduce((sum, point) => sum + point.requests, 0)
  const activeTotal = metric === 'cost' ? totalCost : totalCalls
  const failed = Boolean(stats.error) && !stats.data
  const multi = metric === 'calls'

  return (
    <PanelCard
      title='用量趋势'
      className={cn('min-h-[300px]', className)}
      action={
        <div className='flex items-stretch'>
          {multi ? (
            <div className='mr-2 inline-flex rounded-md border bg-muted/30 p-0.5'>
              <ModeButton
                active={chartMode === 'overlay'}
                onClick={() => setChartMode('overlay')}
              >
                叠加
              </ModeButton>
              <ModeButton
                active={chartMode === 'stacked'}
                onClick={() => setChartMode('stacked')}
              >
                堆叠
              </ModeButton>
            </div>
          ) : null}
          <div className='flex border-l border-border/50'>
            {RANGES.map((item) => (
              <button
                key={item.id}
                type='button'
                aria-pressed={range === item.id}
                className={cn(
                  'border-l border-border/50 px-3 py-1.5 text-xs font-medium first:border-l-0',
                  range === item.id
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/50'
                )}
                onClick={() => setRange(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className='grid grid-cols-2 border-b border-border/50'>
        <MetricTab
          pressed={metric === 'cost'}
          label='总费用'
          value={fmtUsd(totalCost)}
          onClick={() => setMetric('cost')}
        />
        <MetricTab
          pressed={metric === 'calls'}
          label='总调用'
          value={fmtNum(totalCalls)}
          onClick={() => setMetric('calls')}
          edge
        />
      </div>
      <div className='min-h-[300px] px-2 py-3'>
        {stats.isLoading && !stats.data ? (
          <Skeleton className='mx-2 h-[280px] w-auto' />
        ) : failed ? (
          <div className='grid h-[280px] place-items-center text-sm text-destructive'>
            统计加载失败
          </div>
        ) : activeTotal === 0 ? (
          <div className='grid h-[280px] place-items-center text-sm text-muted-foreground'>
            暂无数据
          </div>
        ) : (
          <ResponsiveContainer width='100%' height={300}>
            <AreaChart
              data={points}
              margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id='fill-cost' x1='0' y1='0' x2='0' y2='1'>
                  <stop
                    offset='5%'
                    stopColor='var(--chart-1)'
                    stopOpacity={0.8}
                  />
                  <stop
                    offset='95%'
                    stopColor='var(--chart-1)'
                    stopOpacity={0.1}
                  />
                </linearGradient>
                <linearGradient id='fill-success' x1='0' y1='0' x2='0' y2='1'>
                  <stop
                    offset='5%'
                    stopColor='var(--chart-2)'
                    stopOpacity={0.8}
                  />
                  <stop
                    offset='95%'
                    stopColor='var(--chart-2)'
                    stopOpacity={0.1}
                  />
                </linearGradient>
                <linearGradient id='fill-errors' x1='0' y1='0' x2='0' y2='1'>
                  <stop
                    offset='5%'
                    stopColor='var(--status-bad)'
                    stopOpacity={0.7}
                  />
                  <stop
                    offset='95%'
                    stopColor='var(--status-bad)'
                    stopOpacity={0.05}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                strokeDasharray='3 3'
                stroke='var(--border)'
              />
              <XAxis
                dataKey='label'
                tickLine={false}
                axisLine={false}
                minTickGap={28}
                tick={{ fontSize: 10.5, fill: 'var(--muted-foreground)' }}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(value: number) =>
                  metric === 'cost' ? fmtUsd(value) : fmtNum(value)
                }
                tick={{ fontSize: 10.5, fill: 'var(--muted-foreground)' }}
              />
              <Tooltip
                formatter={(value, name) => [
                  metric === 'cost'
                    ? fmtUsd(Number(value))
                    : fmtNum(Number(value)),
                  String(name),
                ]}
              />
              {multi ? <Legend wrapperStyle={{ fontSize: 12 }} /> : null}
              {metric === 'cost' ? (
                <Area
                  type='monotone'
                  dataKey='cost'
                  name='全部'
                  stroke='var(--chart-1)'
                  fill='url(#fill-cost)'
                  strokeWidth={2}
                  isAnimationActive={false}
                />
              ) : (
                <>
                  <Area
                    type='monotone'
                    dataKey='success'
                    name='成功'
                    stroke='var(--chart-2)'
                    fill='url(#fill-success)'
                    strokeWidth={2}
                    stackId={chartMode === 'stacked' ? 'calls' : undefined}
                    isAnimationActive={false}
                  />
                  <Area
                    type='monotone'
                    dataKey='errors'
                    name='错误'
                    stroke='var(--status-bad)'
                    fill='url(#fill-errors)'
                    strokeWidth={2}
                    stackId={chartMode === 'stacked' ? 'calls' : undefined}
                    isAnimationActive={false}
                  />
                </>
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
        {stats.error && stats.data ? (
          <p className='px-4 pt-2 text-xs text-destructive'>统计加载失败</p>
        ) : null}
      </div>
    </PanelCard>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type='button'
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded px-2 py-0.5 text-[10px]',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground'
      )}
    >
      {children}
    </button>
  )
}

function MetricTab({
  pressed,
  label,
  value,
  onClick,
  edge,
}: {
  pressed: boolean
  label: string
  value: string
  onClick: () => void
  edge?: boolean
}) {
  return (
    <button
      type='button'
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex flex-col items-start gap-0.5 px-4 py-2 text-left',
        edge && 'border-l border-border/50',
        pressed ? 'bg-muted/50' : 'hover:bg-muted/30'
      )}
    >
      <span className='text-[10px] tracking-wide text-muted-foreground uppercase'>
        {label}
      </span>
      <span className='text-base font-bold tabular-nums'>{value}</span>
    </button>
  )
}
