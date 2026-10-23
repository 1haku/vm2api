import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { PersonaPreset } from '@/types/panel-routing'
import type { Vm } from '@/types/panel-vm'
import { Compass } from 'lucide-react'
import { personaPresetLabel } from '@/lib/persona-template'
import { isCodexVm } from '@/lib/vm-kind'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { Notice } from './persona-editors'
import { protocolFixedFields } from './protocol-authority'
import { outboundProfileQueryOptions, type ShapeRow } from './queries'
import { PaneSection } from './scheduler-controls'

const SOURCE_LABELS: Record<string, string> = {
  panel: '面板',
  vm: '槽位覆盖',
  profile: '档案',
  credential: '凭据类型',
  slot: '槽位身份',
}

function SourceBadge({ source }: { source: string }) {
  return (
    <Badge variant='outline' className='shrink-0 font-normal'>
      {SOURCE_LABELS[source] || source}
    </Badge>
  )
}

function Row({
  label,
  value,
  source,
  note,
}: {
  label: string
  value: React.ReactNode
  source: string
  note?: string
}) {
  return (
    <div className='grid gap-1 py-2 sm:grid-cols-[9rem_minmax(0,1fr)] sm:items-start sm:gap-3'>
      <dt className='text-xs text-muted-foreground sm:pt-0.5'>{label}</dt>
      <dd className='flex min-w-0 items-start justify-between gap-3'>
        <div className='min-w-0'>
          <div className='font-mono text-xs break-all'>{value}</div>
          {note ? (
            <p className='mt-0.5 text-[11px] leading-4 text-muted-foreground'>
              {note}
            </p>
          ) : null}
        </div>
        <SourceBadge source={source} />
      </dd>
    </div>
  )
}

function fixedValue(value: unknown) {
  return value === undefined ? '未写' : JSON.stringify(value)
}

function ShapeTable({ shapes }: { shapes: ShapeRow[] }) {
  return (
    <div className='grid gap-3 md:grid-cols-2'>
      {shapes.map((row) => (
        <div key={row.shape} className='rounded-lg border px-3 py-2.5'>
          <div className='flex items-center gap-2'>
            <span className='text-sm font-medium'>{row.label}</span>
            <Badge variant='secondary' className='font-mono font-normal'>
              {row.shape}
            </Badge>
          </div>
          <p className='mt-1 text-xs text-muted-foreground'>{row.models}</p>
          <ul className='mt-2 space-y-1 text-xs leading-5'>
            {(row.rules.system || []).map((item) => (
              <li key={item}>system · {item}</li>
            ))}
            {(row.rules.messages || []).map((item) => (
              <li key={item}>{item}</li>
            ))}
            {row.rules.markers ? (
              <li>断点恰好 {row.rules.markers} 个，TTL 取面板</li>
            ) : null}
            {row.rules.note ? <li>{row.rules.note}</li> : null}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * 只读「当前出站参照」：所选范围下实际发出去的版本、头、断点规则与来源。
 * 数据是已保存的配置，草稿要保存后才反映到这里。
 */
export function OutboundReference({
  storedCompat,
  storedInference,
  dirty,
}: {
  storedCompat: Record<string, unknown> | undefined
  storedInference: Record<string, unknown> | undefined
  dirty: boolean
}) {
  const [scope, setScope] = useState('')
  const dashboard = useQuery(dashboardQueryOptions())
  const slots = (dashboard.data?.vms || []).filter((vm: Vm) => !isCodexVm(vm))
  const query = useQuery(outboundProfileQueryOptions(scope))
  const profile = query.data?.profile
  const fixed = protocolFixedFields(storedCompat, storedInference)
  const drift = fixed.filter((field) => field.stored !== field.saved)

  return (
    <PaneSection
      icon={Compass}
      title='当前出站参照'
      desc='只读。按已保存的配置列出出站版本、请求头、system 结构和断点规则，以及每一项由谁决定。'
      aside={
        profile ? (
          <Badge
            variant={profile.profile.descriptive ? 'secondary' : 'default'}
          >
            {profile.profile.version}
          </Badge>
        ) : null
      }
    >
      <div className='space-y-1.5 sm:max-w-xs'>
        <Label htmlFor='outbound-reference-scope'>范围</Label>
        <Select
          value={scope || '__global__'}
          onValueChange={(value) =>
            setScope(value === '__global__' ? '' : value)
          }
        >
          <SelectTrigger id='outbound-reference-scope' className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value='__global__'>全局（未覆盖的槽位）</SelectItem>
            {slots.map((vm: Vm) => (
              <SelectItem key={vm.id} value={vm.id}>
                {vm.name ? `${vm.id} · ${vm.name}` : vm.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {dirty ? (
        <p className='text-xs text-muted-foreground'>
          有未保存的改动，保存后这里才会更新。
        </p>
      ) : null}

      {query.isError ? (
        <p role='alert' className='text-sm text-destructive'>
          读取失败：{query.error.message}
        </p>
      ) : !profile ? (
        <p className='text-sm text-muted-foreground'>读取中…</p>
      ) : (
        <>
          <dl className='divide-y'>
            <Row
              label='提示词档'
              value={`${personaPresetLabel(profile.preset.value as PersonaPreset)}（${profile.preset.value}）`}
              source={profile.preset.source}
            />
            <Row
              label='档案版本'
              value={profile.profile.version}
              source={profile.profile.source}
              note={
                profile.profile.descriptive
                  ? '现有档位，出站结构不按档案重排'
                  : '按 2.1.303 档案组装'
              }
            />
            <Row
              label='User-Agent'
              value={profile.user_agent.value}
              source={profile.user_agent.source}
            />
            <Row
              label='Stainless 包版本'
              value={profile.stainless_package_version.value}
              source={profile.stainless_package_version.source}
            />
            <Row
              label='billing'
              value={`cc_version=${profile.billing.cc_version}；字段 ${profile.billing.fields.join(' / ')}`}
              source={profile.billing.source}
            />
            <Row
              label='anthropic-beta'
              value={profile.anthropic_beta.value}
              source={profile.anthropic_beta.source}
              note={`${profile.anthropic_beta.credential_mode ? `${profile.anthropic_beta.credential_mode} · ` : ''}${profile.anthropic_beta.sample_model} · ${profile.anthropic_beta.note}`}
            />
            <Row
              label='缓存 TTL'
              value={profile.cache_ttl.value}
              source={profile.cache_ttl.source}
            />
            <Row
              label='CCH'
              value={profile.cch_enabled.value ? '计算' : '固定 00000'}
              source={profile.cch_enabled.source}
            />
            <Row
              label='时区'
              value={
                profile.timezone.value ||
                (profile.scope === 'vm' ? '槽位未设置' : '按槽位')
              }
              source={profile.timezone.source}
            />
            <Row
              label='thinking 显示'
              value={profile.thinking_display.value}
              source={profile.thinking_display.source}
            />
            <Row
              label='官方透传'
              value={profile.official_cc_passthrough.value ? '开' : '关'}
              source={profile.official_cc_passthrough.source}
              note={profile.official_cc_passthrough.note}
            />
          </dl>

          {profile.shapes ? (
            <div className='space-y-2'>
              <h4 className='text-xs font-medium'>按模型分流</h4>
              <ShapeTable shapes={profile.shapes} />
              {profile.top_level_order ? (
                <p className='font-mono text-[11px] break-all text-muted-foreground'>
                  顶层顺序 {profile.top_level_order.join(' → ')}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <div className='space-y-2'>
        <h4 className='text-xs font-medium'>协议页保存时固定写入</h4>
        <ul className='grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2'>
          {fixed.map((field) => (
            <li key={field.key} className='flex min-w-0 items-baseline gap-2'>
              <span className='shrink-0 text-muted-foreground'>
                {field.label}
              </span>
              <span className='font-mono break-all'>
                {fixedValue(field.saved)}
              </span>
            </li>
          ))}
        </ul>
        {drift.length ? (
          <Notice tone='caution'>
            当前存储与保存值不同，下次保存会改写：
            {drift
              .map(
                (field) =>
                  `${field.label} ${fixedValue(field.stored)} → ${fixedValue(field.saved)}`
              )
              .join('；')}
          </Notice>
        ) : null}
      </div>
    </PaneSection>
  )
}
