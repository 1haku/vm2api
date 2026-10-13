import { cn } from '@/lib/utils'
import {
  type ProxyRegionFilter,
  REGION_ANY,
  type RegionGroup,
  type RegionTally,
} from './proxy-region'

/**
 * 地区分面。宽屏是表格左侧的竖栏，窄屏折成表格上方可横向滚动的一排。
 *
 * 每档右侧两个数：当前筛选下的条数、其中可绑的空位。找节点的问题通常是
 * 「这个地区还能不能塞」，所以空位和条数并排，不用点进去再数。
 */
export function ProxyRegionRail({
  groups,
  value,
  onChange,
  totalCount,
  totalFree,
}: {
  groups: RegionGroup[]
  value: ProxyRegionFilter
  onChange: (next: ProxyRegionFilter) => void
  totalCount: number
  totalFree: number
}) {
  const active = groups.find((g) => g.country === value.country)
  return (
    <nav
      aria-label='按地区筛选'
      className='min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100svh-6rem)] lg:overflow-y-auto lg:overscroll-contain'
    >
      <h3 className='mb-1.5 hidden px-2 text-xs font-medium text-muted-foreground lg:block'>
        地区
      </h3>
      <ul className='-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:mx-0 lg:flex-col lg:gap-px lg:overflow-visible lg:px-0 lg:pb-0'>
        <li className='shrink-0'>
          <RegionButton
            label='全部地区'
            tally={{ count: totalCount, free: totalFree }}
            on={!value.country}
            onClick={() => onChange(REGION_ANY)}
          />
        </li>
        {groups.map((g) => {
          const on = value.country === g.country
          return (
            <li key={g.country} className='shrink-0'>
              <RegionButton
                label={g.label}
                tally={g}
                on={on && !value.city}
                within={on && !!value.city}
                onClick={() =>
                  onChange(
                    on && !value.city
                      ? REGION_ANY
                      : { country: g.country, city: '' }
                  )
                }
              />
              {on && g.cities.length ? (
                <ul
                  aria-label={`${g.label}的城市`}
                  className='hidden lg:mt-px lg:flex lg:flex-col lg:gap-px'
                >
                  {g.cities.map((c) => (
                    <li key={c.city}>
                      <RegionButton
                        label={c.city}
                        tally={c}
                        nested
                        on={value.city === c.city}
                        onClick={() =>
                          onChange({
                            country: g.country,
                            city: value.city === c.city ? '' : c.city,
                          })
                        }
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          )
        })}
        {/* 窄屏横排里城市跟在选中的国家后面，竖栏里它们已经嵌在国家下方。 */}
        {active?.cities.map((c) => (
          <li key={`m-${c.city}`} className='shrink-0 lg:hidden'>
            <RegionButton
              label={c.city}
              tally={c}
              nested
              on={value.city === c.city}
              onClick={() =>
                onChange({
                  country: active.country,
                  city: value.city === c.city ? '' : c.city,
                })
              }
            />
          </li>
        ))}
      </ul>
    </nav>
  )
}

function RegionButton({
  label,
  tally,
  on,
  within = false,
  nested = false,
  onClick,
}: {
  label: string
  tally: RegionTally
  on: boolean
  /** 选中的是这个国家下的某个城市。 */
  within?: boolean
  nested?: boolean
  onClick: () => void
}) {
  const empty = tally.count === 0
  return (
    <button
      type='button'
      aria-pressed={on}
      onClick={onClick}
      title={`${label}：${tally.count} 条，空位 ${tally.free}`}
      className={cn(
        'group flex h-8 w-full items-center gap-2 rounded-md px-2 text-start text-[13px] whitespace-nowrap transition-colors',
        'border border-transparent bg-muted/50 lg:bg-transparent',
        'hover:bg-accent/70 focus-visible:outline-2 focus-visible:outline-ring',
        nested && 'lg:h-7 lg:ps-5 lg:text-xs',
        on
          ? 'border-primary/30 bg-primary/10 font-medium text-foreground lg:bg-primary/10'
          : within
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        empty && !on && 'opacity-50'
      )}
    >
      <span className='min-w-0 flex-1 truncate'>{label}</span>
      <span className='shrink-0 text-xs text-foreground/80 tabular-nums'>
        {tally.count}
      </span>
      <span
        className={cn(
          'w-9 shrink-0 text-end text-[11px] tabular-nums',
          tally.free
            ? 'text-[color:var(--status-ok)]'
            : 'text-muted-foreground/70'
        )}
      >
        空 {tally.free}
      </span>
    </button>
  )
}
