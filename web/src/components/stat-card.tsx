import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

type StatCardTone = 'neutral' | 'caution' | 'warn' | 'bad'

const TONE_BAR: Record<Exclude<StatCardTone, 'neutral'>, string> = {
  caution: 'border-l-2 border-l-[color:var(--status-caution)]',
  warn: 'border-l-2 border-l-[color:var(--status-warn)]',
  bad: 'border-l-2 border-l-[color:var(--status-bad)]',
}

export function StatCard({
  label,
  value,
  hint,
  tone = 'neutral',
  compact = false,
}: {
  label: string
  value: string
  hint?: string
  tone?: StatCardTone
  compact?: boolean
}) {
  return (
    <Card
      className={cn(
        'shadow-none',
        compact && 'gap-2 py-4',
        tone !== 'neutral' && TONE_BAR[tone]
      )}
    >
      <CardHeader className={cn('pb-2', compact && 'px-4 pb-0')}>
        <CardTitle className='text-sm font-medium text-muted-foreground'>
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className={cn(compact && 'px-4')}>
        <div
          className={cn(
            'text-2xl font-semibold tabular-nums',
            compact && 'text-xl'
          )}
        >
          {value}
        </div>
        {hint ? <p className='text-xs text-muted-foreground'>{hint}</p> : null}
      </CardContent>
    </Card>
  )
}
