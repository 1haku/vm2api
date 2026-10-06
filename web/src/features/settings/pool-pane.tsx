import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingRow } from '@/components/setting-row'

type PoolPaneProps = {
  pool: Record<string, unknown>
  failover: Record<string, unknown>
  onPoolChange: (next: Record<string, unknown>) => void
  onFailoverChange: (next: Record<string, unknown>) => void
}

/** 配置存小数，界面显示百分数；保留一位小数，避免 0.07 × 100 的浮点尾巴。 */
function percentOf(fraction: unknown, fallback: number): number {
  const n = Number(fraction ?? fallback)
  return Math.round((Number.isFinite(n) ? n : fallback) * 1000) / 10
}

export function PoolPane(props: PoolPaneProps) {
  const { pool, failover, onPoolChange, onFailoverChange } = props
  return (
    <Card>
      <CardHeader>
        <CardTitle>账号池</CardTitle>
        <p className='text-xs text-muted-foreground'>
          只调度 Claude VM。三态是开 / 受限 /
          关。操作员开关只拨开或关；额度、429、冷却和熔断写成受限，窗口或探测成功后自动恢复，不会拨成调度关。
        </p>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow
          label='策略'
          desc='只作用于 Claude VM 的新席位。平衡：先开占用比例最低的 VM；填充：先填满占用比例最高的 VM。同比例再按配额余量。'
        >
          <Select
            value={pool.strategy === 'fill' ? 'fill' : 'balanced'}
            onValueChange={(strategy) => onPoolChange({ ...pool, strategy })}
          >
            <SelectTrigger className='w-56'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='balanced'>平衡</SelectItem>
              <SelectItem value='fill'>填充</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label='同 VM 重试'
          desc='可重试错误时，没有别的空闲 VM 才回同一台再试的次数；空响应不受此限。同一 VM 每请求最多执行 3 次'
        >
          <Input
            className='w-24'
            type='number'
            min={0}
            max={5}
            value={Number(failover.max_same_account_retries ?? 1)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                max_same_account_retries: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow label='同 VM 重试间隔' desc='毫秒，默认 500'>
          <Input
            className='w-24'
            type='number'
            min={0}
            value={Number(failover.same_account_retry_delay_ms ?? 500)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                same_account_retry_delay_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='熔断失败次数'
          desc='同一台 Claude VM 连续 5xx 达到该次数后打开熔断，529 和 401 不计入'
        >
          <Input
            className='w-24'
            type='number'
            min={1}
            max={20}
            value={Number(pool.circuit_failure_threshold ?? 3)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                circuit_failure_threshold: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='熔断打开时长'
          desc='毫秒。到期后只放行 1 个探测请求，默认 30000'
        >
          <Input
            className='w-24'
            type='number'
            min={1000}
            value={Number(pool.circuit_open_ms ?? 30000)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                circuit_open_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='切号上限'
          desc='用完后只再尝试本请求还没试过的 VM，直到总时限'
        >
          <Input
            className='w-24'
            type='number'
            value={Number(failover.max_account_switches ?? 10)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                max_account_switches: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='总尝试'
          desc='用完后不再重复同一 VM，只尝试还没试过的 VM，直到总时限'
        >
          <Input
            className='w-24'
            type='number'
            value={Number(failover.max_total_attempts ?? 12)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                max_total_attempts: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='允许排队数量'
          desc='全部 Claude 排队请求的总数（等席位、并发、冷却 / RPM），范围 1–999，默认 50；满了新请求直接 529'
        >
          <Input
            className='w-24'
            type='number'
            min={1}
            max={999}
            value={Number(pool.queue_max ?? 50)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                queue_max: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='席位宽限'
          desc='毫秒，范围 0–120000，默认 30000。请求结束后席位为同一设备保留的时长'
        >
          <Input
            className='w-24'
            type='number'
            min={0}
            max={120000}
            value={Number(pool.seat_grace_ms ?? 30000)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                seat_grace_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='每席位预算预留'
          desc='百分比，范围 0–50，默认 2。VM 的 5h/7d 余量至少为（已占席位 + 1）× 该值才开新席位'
        >
          <Input
            className='w-24'
            type='number'
            min={0}
            max={50}
            step={0.5}
            value={percentOf(pool.seat_budget_reserve_pct, 0.02)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                seat_budget_reserve_pct: Number(event.target.value) / 100,
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='粘性等待超时'
          desc='毫秒，范围 1000–120000，默认 45000'
        >
          <Input
            className='w-24'
            type='number'
            min={1000}
            max={120000}
            value={Number(pool.sticky_wait_timeout_ms ?? 45000)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                sticky_wait_timeout_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='回退等待超时'
          desc='毫秒，范围 1000–120000，默认 30000'
        >
          <Input
            className='w-24'
            type='number'
            min={1000}
            max={120000}
            value={Number(pool.fallback_wait_timeout_ms ?? 30000)}
            onChange={(event) =>
              onPoolChange({
                ...pool,
                fallback_wait_timeout_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow
          label='总重试时限'
          desc='毫秒，整请求 failover 上限，默认 120000'
        >
          <Input
            className='w-24'
            type='number'
            min={1000}
            value={Number(failover.total_retry_deadline_ms ?? 120000)}
            onChange={(event) =>
              onFailoverChange({
                ...failover,
                total_retry_deadline_ms: Number(event.target.value),
              })
            }
          />
        </SettingRow>
        <SettingRow label='401 冷却' desc='OAuth 401 后该账号退出调度的时长'>
          <Select
            value={String(failover.oauth_401_cooldown_ms ?? 120000)}
            onValueChange={(cooldownMs) =>
              onFailoverChange({
                ...failover,
                oauth_401_cooldown_ms: Number(cooldownMs),
              })
            }
          >
            <SelectTrigger className='w-56'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='30000'>30 秒</SelectItem>
              <SelectItem value='120000'>2 分钟</SelectItem>
              <SelectItem value='300000'>5 分钟</SelectItem>
              <SelectItem value='600000'>10 分钟</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label='流式交付'>
          <Select
            value={String(failover.delivery_mode || 'realtime')}
            onValueChange={(deliveryMode) =>
              onFailoverChange({
                ...failover,
                delivery_mode: deliveryMode,
              })
            }
          >
            <SelectTrigger className='w-56'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='realtime'>realtime</SelectItem>
              <SelectItem value='verified'>verified</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
      </CardContent>
    </Card>
  )
}
