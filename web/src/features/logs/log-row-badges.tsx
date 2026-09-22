import type { RequestLogItem } from '@/types/panel-logs'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import {
  errorClassBadge,
  rateBadge,
  showModelRedirect,
  statusBadge,
  type LogBadge,
  type LogBadgeTone,
} from './log-badges'

const TONE_CLASS: Record<LogBadgeTone, string> = {
  ok: 'border-green-300 bg-green-100 text-green-700 dark:border-green-700 dark:bg-green-900/30 dark:text-green-400',
  caution:
    'border-yellow-300 bg-yellow-100 text-yellow-700 dark:border-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  warn: 'border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  bad: 'border-red-300 bg-red-100 text-red-700 dark:border-red-700 dark:bg-red-900/30 dark:text-red-400',
  none: 'border-gray-300 bg-gray-100 text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300',
}

export function LogToneBadge({
  badge,
  className,
}: {
  badge: LogBadge
  className?: string
}) {
  return (
    <Badge
      variant='outline'
      className={cn(
        'h-4 px-1 py-0 text-[10px] font-medium',
        TONE_CLASS[badge.tone],
        className
      )}
    >
      {badge.text}
    </Badge>
  )
}

export function StatusBadges({ row }: { row: RequestLogItem }) {
  const err = errorClassBadge(row)
  return (
    <>
      <LogToneBadge badge={statusBadge(row.status)} />
      {err ? <LogToneBadge badge={err} /> : null}
    </>
  )
}

export function RateMultiplierBadge({ row }: { row: RequestLogItem }) {
  const badge = rateBadge(row.rate_multiplier)
  if (!badge) return null
  return <LogToneBadge badge={badge} />
}

export function RedirectBadge({ row }: { row: RequestLogItem }) {
  if (!showModelRedirect(row)) return null
  return (
    <Badge
      variant='outline'
      className='h-4 border-indigo-300 bg-indigo-50 px-1 py-0 text-[10px] text-indigo-700 dark:border-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
    >
      重定向
    </Badge>
  )
}

export function CacheBadge({
  write,
  read,
}: {
  write: number
  read: number
}) {
  if (write <= 0 && read <= 0) return null
  const text = write > 0 && read > 0 ? '读写' : write > 0 ? '写' : '读'
  return (
    <Badge
      variant='outline'
      className='h-4 border-blue-300 bg-blue-100 px-1 py-0 text-[10px] text-blue-700 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
    >
      {text}
    </Badge>
  )
}
