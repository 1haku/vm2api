import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Minimize2 } from 'lucide-react'
import { fmtMs, fmtNum } from '@/lib/format'
import { opsSince } from '@/lib/ops-window'
import { Button } from '@/components/ui/button'
import { logStatsQueryOptions } from '@/features/logs/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import type { HideableLogColumn } from './column-visibility'
import { LogsStream, type LogsStreamFilters } from './logs-stream'

const LIVE_POLL_MS = 3000

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'ok' | 'warn' | 'bad'
}) {
  return (
    <div className='flex flex-col justify-center px-5'>
      <div className='text-[10px] font-semibold tracking-wider text-muted-foreground uppercase'>
        {label}
      </div>
      <div
        className='font-mono text-xl leading-none font-bold tabular-nums'
        style={tone ? { color: `var(--status-${tone})` } : undefined}
      >
        {value}
      </div>
    </div>
  )
}

function slaTone(sla: number | undefined): 'ok' | 'warn' | 'bad' | undefined {
  if (sla == null) return undefined
  const p = sla * 100
  if (p < 90) return 'bad'
  if (p < 99) return 'warn'
  return 'ok'
}

/**
 * 全屏值班大屏（对齐 claude-code-hub 的 fullscreen live logs）：
 * 3s 轮询的流式日志 + 顶部实时指标条（当前并发 / 1h 请求 / 成功率 / 首字 p50）。
 * 原生 fullscreen 的进入/退出由 LogsPage 管，这里只管画面与 ESC 兜底。
 */
export function LogsFullscreen({
  filters,
  vms,
  showIngress,
  hidden,
  onOpenDetail,
  onExit,
}: {
  filters: LogsStreamFilters
  vms?: Map<string, Vm>
  showIngress?: boolean
  hidden?: readonly HideableLogColumn[]
  onOpenDetail: (id: string) => void
  onExit: () => void
}) {
  const since = opsSince('1h')
  const stats = useQuery(logStatsQueryOptions(since, LIVE_POLL_MS))
  const dash = useQuery(dashboardQueryOptions(LIVE_POLL_MS))

  // 浏览器拒绝原生全屏（或不支持）时的兜底：ESC 也要能退出这层覆盖。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onExit])

  const w = stats.data?.window
  const sla = w?.sla != null ? `${(w.sla * 100).toFixed(1)}%` : '—'
  const concurrent = (dash.data?.vms || []).reduce(
    (n, v) => n + (Number(v.inflight) || 0),
    0
  )

  return (
    <div
      className='fixed inset-0 z-50 flex flex-col bg-background'
      role='dialog'
      aria-modal='true'
      aria-label='日志实时大屏'
    >
      <div className='flex h-14 items-center justify-between gap-4 border-b px-4'>
        <div className='flex min-w-0 items-center gap-2.5'>
          <span className='relative flex size-2'>
            <span className='absolute inline-flex size-full animate-ping rounded-full bg-primary/70' />
            <span className='relative inline-flex size-2 rounded-full bg-primary' />
          </span>
          <span className='truncate text-base font-semibold tracking-tight'>
            请求日志 · 实时
          </span>
        </div>
        <div className='flex items-center gap-2'>
          <div className='hidden h-full items-stretch divide-x divide-border/50 md:flex'>
            <Metric label='当前并发' value={String(concurrent)} />
            <Metric label='1h 请求' value={fmtNum(w?.requests || 0)} />
            <Metric label='成功率' value={sla} tone={slaTone(w?.sla)} />
            <Metric label='首字 p50' value={fmtMs(w?.ttft?.p50_ms)} />
          </div>
          <Button
            variant='outline'
            size='sm'
            className='gap-2'
            onClick={onExit}
          >
            <Minimize2 className='size-4' />
            退出全屏
          </Button>
        </div>
      </div>
      <div className='min-h-0 flex-1 p-3'>
        <LogsStream
          filters={filters}
          vms={vms}
          onOpenDetail={onOpenDetail}
          showIngress={showIngress}
          hidden={hidden}
          pollMs={LIVE_POLL_MS}
          viewportClassName='h-[calc(100dvh-56px-24px-32px-28px)]'
        />
      </div>
    </div>
  )
}
