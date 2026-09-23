import type { OpsWindow } from '@/types/panel-overview'
import { BarChart3 } from 'lucide-react'
import { fmtNum, fmtUsd } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'

function StatCell({
  title,
  value,
  lines,
}: {
  title: string
  value: string
  lines?: { label: string; value: string }[]
}) {
  return (
    <div className='rounded-lg border border-border/50 bg-card/20 p-4'>
      <div className='mb-1 text-sm text-muted-foreground'>{title}</div>
      <div className='font-mono text-2xl font-semibold tabular-nums'>
        {value}
      </div>
      {lines ? (
        <div className='mt-2 space-y-1 text-xs text-muted-foreground'>
          {lines.map((line) => (
            <div key={line.label} className='flex justify-between gap-3'>
              <span>{line.label}</span>
              <span className='font-mono'>{line.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function LogsStatsStrip({
  loading,
  error,
  windowLabel,
  window: stats,
}: {
  loading: boolean
  error: unknown
  windowLabel: string
  window?: OpsWindow
}) {
  const requests = Number(stats?.requests || 0)
  const cost = Number(stats?.total_cost || 0)
  const input = Number(stats?.input_tokens || 0)
  const output = Number(stats?.output_tokens || 0)
  const cacheWrite = Number(stats?.cache_creation_tokens || 0)
  const cacheRead = Number(stats?.cache_read_tokens || 0)

  return (
    <div
      className={cn(
        'relative mb-3 overflow-hidden rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm'
      )}
    >
      <div className='pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.02] to-transparent' />
      <div className='relative z-10'>
        <div className='flex items-center gap-3 border-b border-border/30 px-4 py-3'>
          <span className='flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground'>
            <BarChart3 className='size-4' />
          </span>
          <div className='space-y-0.5'>
            <h3 className='text-sm leading-none font-semibold'>当前窗口汇总</h3>
            <p className='text-xs text-muted-foreground'>{windowLabel}</p>
          </div>
        </div>
        <div className='px-4 py-4'>
          {loading && !stats ? (
            <div className='grid gap-4 md:grid-cols-4'>
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className='h-24 rounded-lg' />
              ))}
            </div>
          ) : error && !stats ? (
            <div className='py-4 text-center text-sm text-destructive'>
              汇总加载失败
            </div>
          ) : (
            <div className='grid gap-4 md:grid-cols-4'>
              <StatCell title='请求数' value={fmtNum(requests)} />
              <StatCell title='费用' value={fmtUsd(cost)} />
              <StatCell
                title='Tokens'
                value={fmtNum(input + output)}
                lines={[
                  { label: '输入', value: fmtNum(input) },
                  { label: '输出', value: fmtNum(output) },
                ]}
              />
              <StatCell
                title='缓存'
                value={fmtNum(cacheWrite + cacheRead)}
                lines={[
                  { label: '写', value: fmtNum(cacheWrite) },
                  { label: '读', value: fmtNum(cacheRead) },
                ]}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
