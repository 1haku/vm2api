import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { usageDates, type UsageSearch } from './filters'

export function DateRange({
  search,
  onChange,
}: {
  search: UsageSearch
  onChange: (patch: UsageSearch) => void
}) {
  const { range, from, until, valid } = usageDates(search)
  return (
    <div className='flex flex-wrap items-end gap-3'>
      <div className='flex gap-1 rounded-lg bg-muted p-1' aria-label='统计时间'>
        {(
          [
            ['today', '今天'],
            ['7d', '近 7 天'],
            ['30d', '近 30 天'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            size='sm'
            aria-pressed={range === value}
            className={
              range === value
                ? 'bg-background shadow-sm ring-1 ring-border'
                : ''
            }
            variant={range === value ? 'secondary' : 'ghost'}
            onClick={() =>
              onChange({ range: value, from: undefined, until: undefined })
            }
          >
            {label}
          </Button>
        ))}
      </div>
      <label className='grid gap-1 text-xs text-muted-foreground'>
        开始日期
        <Input
          aria-label='开始日期'
          type='date'
          className='h-9 w-36'
          value={from}
          onChange={(e) =>
            onChange({ range: 'custom', from: e.target.value, until })
          }
        />
      </label>
      <label className='grid gap-1 text-xs text-muted-foreground'>
        结束日期
        <Input
          aria-label='结束日期'
          type='date'
          className='h-9 w-36'
          value={until}
          onChange={(e) =>
            onChange({ range: 'custom', from, until: e.target.value })
          }
        />
      </label>
      {!valid && (
        <p role='alert' className='text-sm text-destructive'>
          结束日期不能早于开始日期
        </p>
      )}
    </div>
  )
}
