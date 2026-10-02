import { cn } from '@/lib/utils'

/**
 * 环形健康度。对齐 index.html 的 `donut(score, label)`：颜色按分档
 * （≥80 ok / ≥50 caution / 其余 bad），中心显示原始分数（非百分号）。
 * `CircularProgress` 不支持自定义中心文案（只会渲染百分比），健康分需要
 * 「纯数字 + 下方标签」两行版式，故这里保留一个专用的小 SVG 而不硬套它。
 */
export function HealthDonut({
  score,
  label,
  size = 92,
}: {
  score: number
  label: string
  size?: number
}) {
  const p = Math.max(0, Math.min(100, Number(score) || 0))
  const r = 30
  const c = 2 * Math.PI * r
  const color =
    p >= 80
      ? 'var(--status-ok)'
      : p >= 50
        ? 'var(--status-caution)'
        : 'var(--status-bad)'
  return (
    <svg
      viewBox='0 0 72 72'
      width={size}
      height={size}
      role='img'
      aria-label={`${label} ${p}%`}
      className='shrink-0'
    >
      <circle
        cx={36}
        cy={36}
        r={r}
        fill='none'
        stroke='var(--border)'
        strokeWidth={5}
      />
      <circle
        cx={36}
        cy={36}
        r={r}
        fill='none'
        stroke={color}
        strokeWidth={5}
        strokeLinecap='round'
        strokeDasharray={c.toFixed(1)}
        strokeDashoffset={(c * (1 - p / 100)).toFixed(1)}
        transform='rotate(-90 36 36)'
      />
      <text
        x={36}
        y={31}
        textAnchor='middle'
        dominantBaseline='central'
        className='fill-foreground text-[19px] font-semibold'
        style={{ letterSpacing: '-0.04em' }}
      >
        {p}
      </text>
      <text
        x={36}
        y={51}
        textAnchor='middle'
        className='fill-muted-foreground'
        style={{ fontSize: 8.5 }}
      >
        {label}
      </text>
    </svg>
  )
}

export const HEALTH_SEGMENTS = [
  { key: 'ok', label: '可用', color: 'var(--status-ok)' },
  { key: 'caution', label: '警告', color: 'var(--status-caution)' },
  { key: 'warn', label: '限制', color: 'var(--status-warn)' },
  { key: 'bad', label: '无效凭证', color: 'var(--status-bad)' },
  { key: 'none', label: '未使用', color: 'var(--status-none)' },
] as const

export type HealthBuckets = Record<
  (typeof HEALTH_SEGMENTS)[number]['key'],
  number
>

/** 分段健康条。对齐 index.html 的 `healthBar(buckets, total)`。 */
export function HealthBar({
  buckets,
  total,
}: {
  buckets: HealthBuckets
  total: number
}) {
  const segs = HEALTH_SEGMENTS.filter((s) => buckets[s.key] > 0)
  return (
    <div className='flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-muted'>
      {segs.length ? (
        segs.map((s) => (
          <i
            key={s.key}
            title={`${s.label} ${buckets[s.key]}`}
            style={{
              flex: `${buckets[s.key]} 1 0`,
              minWidth: 6,
              background: s.color,
              borderRadius: 2,
            }}
          />
        ))
      ) : (
        <i
          style={{ flex: Math.max(total, 1), background: 'var(--status-none)' }}
          className='rounded-sm'
        />
      )}
    </div>
  )
}

/** 分段图例。对齐 index.html 的 `healthLegend(buckets)`。 */
export function HealthLegend({ buckets }: { buckets: HealthBuckets }) {
  return (
    <div className='flex flex-wrap gap-x-4 gap-y-1.5'>
      {HEALTH_SEGMENTS.map((s) => (
        <span
          key={s.key}
          className={cn(
            'flex items-center gap-1.5 text-[11.5px] text-muted-foreground',
            buckets[s.key] === 0 && 'opacity-40'
          )}
        >
          <span
            className='block size-1.5 shrink-0 rounded-full'
            style={{ background: s.color }}
          />
          <b className='text-[13px] font-semibold text-foreground tabular-nums'>
            {buckets[s.key]}
          </b>
          {s.label}
        </span>
      ))}
    </div>
  )
}
