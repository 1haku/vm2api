import { useState } from 'react'
import type { Vm, VmProxySnap } from '@/types/panel-vm'
import {
  Activity,
  Copy,
  Ellipsis,
  Globe,
  Lock,
  Pencil,
  Power,
  PowerOff,
  Trash2,
} from 'lucide-react'
import { fmtAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusMark } from '@/components/status-mark'
import { ProxyBindPicker } from './proxy-bind-picker'
import { type ProxyHover, useProxyHovered } from './proxy-hover'
import { SeatCells, SeatCount } from './proxy-seats'
import {
  LOCAL_PROXY_HINT,
  LOCAL_PROXY_SHARED_QUOTA,
  localBoundGroupLabel,
  localBoundGroups,
  proxyBindLimit,
  proxyBindable,
  proxyBoundIds,
  proxyHealthKey,
  proxyHostText,
  proxyIsInvalid,
  proxyIsLocal,
} from './proxy-sort'
import {
  PROXY_HEALTH_SOLID,
  proxyFieldClass,
  proxyLatencyTone,
  proxySignalBars,
  proxyStatusTone,
} from './proxy-tone'
import { VM_DRAG_TYPE, VmChip } from './vm-chip'

export type ProxyRowActions = {
  onProbe: (id: string) => void
  onGeo: (id: string) => void
  onCopy: (id: string) => void
  onEdit: (id: string) => void
  onToggleEnabled: (proxy: VmProxySnap) => void
  onDelete: (id: string) => void
  onBind: (id: string, vmId: string) => void
  onUnbind: (id: string, vmId: string) => void
  onVmDragChange: (vmId: string) => void
}

/** 各类进行中的请求落在哪一行，用于行内转圈而不是整表禁用。 */
export type ProxyRowPending = {
  probe: string
  geo: string
  copy: string
  toggle: string
  /** 绑定 / 解绑会重载槽位，进行中时全表的绑定入口一起锁住，避免同一槽位并发换绑。 */
  binding: boolean
}

/**
 * 表头与每一行共用的列模板。列表容器宽于 `@4xl` 才对齐成表格；更窄时行退回
 * 自动换行的卡片排布，表头隐藏、改用工具条里的排序下拉。
 */
export const PROXY_ROW_GRID =
  '@4xl/plist:grid @4xl/plist:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_88px_84px_120px_minmax(0,1.7fr)_auto] @4xl/plist:items-center @4xl/plist:gap-x-4'

export function ProxyRow({
  proxy,
  vms,
  vmById,
  ownerOf,
  poolLimit,
  hover,
  dragVm,
  pending,
  actions,
}: {
  proxy: VmProxySnap
  vms: Vm[]
  vmById: Map<string, Vm>
  ownerOf: Map<string, VmProxySnap>
  poolLimit: number
  hover: ProxyHover
  /** 正在被拖动的槽位 id，空串表示没有拖动。 */
  dragVm: string
  pending: ProxyRowPending
  actions: ProxyRowActions
}) {
  const id = proxy.id || ''
  const lit = useProxyHovered(hover, id)
  const [over, setOver] = useState(false)
  const ids = proxyBoundIds(proxy)
  const limit = proxyBindLimit(proxy, poolLimit)
  const health = proxyHealthKey(proxy)
  const dead = proxyIsInvalid(proxy) && !proxy.blocked_reason
  const local = proxyIsLocal(proxy)
  const bindable = proxyBindable(proxy)
  const free = Math.max(0, limit - ids.length)
  const groups = local ? localBoundGroups(proxy, vmById) : []
  const showGroups =
    local && (proxy.bound_nodes != null || groups.some((g) => g.node_id))
  const accepts =
    !!dragVm &&
    bindable &&
    free > 0 &&
    !ids.includes(dragVm) &&
    !pending.binding
  const alreadyHere = !!dragVm && ids.includes(dragVm)

  return (
    <li
      id={`proxy-row-${id}`}
      onMouseEnter={() => hover.set(id)}
      onMouseLeave={() => hover.set('')}
      onDragOver={(e) => {
        if (!accepts || !e.dataTransfer.types.includes(VM_DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOver(false)
        }
      }}
      onDrop={(e) => {
        setOver(false)
        const vmId = e.dataTransfer.getData(VM_DRAG_TYPE)
        if (!accepts || !vmId) return
        e.preventDefault()
        actions.onBind(id, vmId)
      }}
      className={cn(
        'flex scroll-mt-24 flex-wrap items-start gap-x-4 gap-y-2 px-4 py-2.5 transition-[background-color,opacity,box-shadow] duration-200',
        PROXY_ROW_GRID,
        dead && 'bg-red-1/60',
        lit && !dragVm && 'bg-accent/40',
        dragVm && !accepts && !alreadyHere && 'opacity-40',
        accepts &&
          'shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--primary)_35%,transparent)]',
        over && 'bg-primary/8 shadow-[inset_0_0_0_2px_var(--primary)]'
      )}
    >
      <div className='min-w-[200px] flex-[1.4] @4xl/plist:min-w-0'>
        <p
          className={cn(
            'truncate text-[13px] font-medium',
            !proxy.label && !local && 'field-host'
          )}
          title={
            local ? proxyHostText(proxy) : proxy.label || proxyHostText(proxy)
          }
        >
          {local ? proxyHostText(proxy) : proxy.label || proxyHostText(proxy)}
        </p>
        <div className='mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground'>
          {local ? (
            <span
              className='truncate'
              title={`${LOCAL_PROXY_HINT}：每台机器自己的公网出口，绑定额度${LOCAL_PROXY_SHARED_QUOTA}`}
            >
              {LOCAL_PROXY_HINT} · 绑定额度{LOCAL_PROXY_SHARED_QUOTA}
            </span>
          ) : proxy.label ? (
            <span className='field-host truncate' title={proxyHostText(proxy)}>
              {proxyHostText(proxy)}
            </span>
          ) : null}
          {proxy.address_family === 6 ? (
            <span className='shrink-0'>IPv6</span>
          ) : null}
          {proxy.has_auth ? (
            <Lock className='size-3 shrink-0' aria-label='已配账密' />
          ) : null}
        </div>
        {proxy.last_error && !proxy.blocked_reason ? (
          <p
            className={cn(
              'field-host mt-0.5 truncate text-[11px]',
              dead
                ? 'text-[color:var(--status-bad)]'
                : 'text-[color:var(--status-warn)]'
            )}
            title={proxy.last_error}
          >
            {proxy.last_error}
            {Number(proxy.consecutive_failures) > 1
              ? ` · 连续 ${proxy.consecutive_failures} 次`
              : ''}
          </p>
        ) : null}
      </div>

      <GeoCell proxy={proxy} local={local} />

      <div className='shrink-0 pt-0.5 @4xl/plist:pt-0'>
        <StatusMark tone={proxyStatusTone(proxy)} />
      </div>

      <div className='w-[84px] shrink-0 @4xl/plist:w-auto'>
        <Latency proxy={proxy} />
        <p className='mt-1 truncate text-[11px] text-muted-foreground'>
          {fmtAgo(proxy.last_probe_at) || '未探测'}
          {local ? ' · 控制面' : ''}
        </p>
      </div>

      <div
        role='meter'
        aria-label='已绑席位'
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={ids.length}
        aria-valuetext={
          local
            ? `已绑 ${ids.length} / ${limit}（${LOCAL_PROXY_SHARED_QUOTA}）`
            : `已绑 ${ids.length} / ${limit}`
        }
        className='flex w-[150px] shrink-0 items-center gap-2 @4xl/plist:w-auto'
      >
        <SeatCount used={ids.length} limit={limit} className='w-11 shrink-0' />
        <SeatCells
          used={ids.length}
          limit={limit}
          color={PROXY_HEALTH_SOLID[health]}
          className='min-w-0 flex-1'
        />
      </div>

      {/* 卡片排布时放到最后独占一行，操作按钮就能跟席位留在同一行。 */}
      <div className='order-last min-w-0 basis-full space-y-1.5 @4xl/plist:order-none @4xl/plist:basis-auto'>
        {showGroups
          ? groups.map((group) => (
              <div key={group.node_id || 'control'} className='space-y-1'>
                <p className='text-[11px] text-muted-foreground'>
                  {localBoundGroupLabel(group)}
                  {group.node_id ? ' · 出口为该节点本机' : ''}
                </p>
                <div className='flex flex-wrap items-center gap-1'>
                  {group.bound_vm_ids.map((vmId) => (
                    <VmChip
                      key={vmId}
                      vm={vmById.get(vmId)}
                      vmId={vmId}
                      tone={dead ? 'bad' : 'ok'}
                      disabled={pending.binding}
                      onUnbind={() => actions.onUnbind(id, vmId)}
                      onDragChange={actions.onVmDragChange}
                    />
                  ))}
                </div>
              </div>
            ))
          : null}
        <div className='flex flex-wrap items-center gap-1'>
          {showGroups
            ? null
            : ids.map((vmId) => (
                <VmChip
                  key={vmId}
                  vm={vmById.get(vmId)}
                  vmId={vmId}
                  tone={dead ? 'bad' : 'ok'}
                  disabled={pending.binding}
                  onUnbind={() => actions.onUnbind(id, vmId)}
                  onDragChange={actions.onVmDragChange}
                />
              ))}
          {over ? (
            <span className='inline-flex h-6 items-center rounded-md border border-dashed border-primary px-2 text-xs text-primary'>
              松开绑定到这里
            </span>
          ) : !bindable ? (
            <span className='text-xs text-muted-foreground'>
              {health === 'off' ? '已禁用，不接新槽位' : '已失效，不接新槽位'}
            </span>
          ) : free > 0 ? (
            <ProxyBindPicker
              vms={vms}
              boundHere={ids}
              ownerOf={ownerOf}
              free={free}
              disabled={pending.binding}
              onBind={(vmId) => actions.onBind(id, vmId)}
            />
          ) : ids.length ? null : (
            <span className='text-xs text-muted-foreground'>无空位</span>
          )}
        </div>
      </div>

      <div className='ms-auto flex shrink-0 items-center gap-0.5 @4xl/plist:ms-0'>
        <Button
          size='icon'
          variant='ghost'
          className='size-8'
          onClick={() => actions.onProbe(id)}
          loading={pending.probe === id}
          disabled={!!proxy.blocked_reason}
          aria-label='测通'
          title='测通：只测 SOCKS TCP，不打 Anthropic'
        >
          <Activity />
        </Button>
        <Button
          size='icon'
          variant='ghost'
          className='size-8'
          onClick={() => actions.onGeo(id)}
          loading={pending.geo === id}
          disabled={!!proxy.blocked_reason}
          aria-label='测地理'
          title='测地理：经这条代理查出口 IP 的国家 / 城市 / 时区'
        >
          <Globe />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size='icon'
              variant='ghost'
              className='size-8'
              aria-label='更多操作'
              loading={pending.copy === id || pending.toggle === id}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='w-44'>
            {local ? null : (
              <>
                <DropdownMenuItem onSelect={() => actions.onCopy(id)}>
                  <Copy />
                  复制地址（含账密）
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => actions.onEdit(id)}>
                  <Pencil />
                  编辑 / 改名
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuItem onSelect={() => actions.onToggleEnabled(proxy)}>
              {proxy.enabled === false ? <Power /> : <PowerOff />}
              {proxy.enabled === false ? '启用' : '禁用'}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant='destructive'
              onSelect={() => actions.onDelete(id)}
            >
              <Trash2 />
              删除
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

/** 地区列：国家 · 城市为主，时区退到第二行。名称没写地区时，这一列就是找节点的依据。 */
function GeoCell({
  proxy,
  local = false,
}: {
  proxy: VmProxySnap
  local?: boolean
}) {
  const geo = proxy.geo
  const note = local ? '控制面探测' : null
  if (!geo?.timezone && !geo?.country) {
    return (
      <div className='min-w-[120px] flex-1 text-[11px] text-muted-foreground @4xl/plist:min-w-0'>
        <p className='truncate'>{geo?.error ? '地理检测失败' : '地理未检测'}</p>
        {note ? <p className='mt-0.5 truncate'>{note}</p> : null}
      </div>
    )
  }
  const country = geo.country_code || geo.country
  return (
    <div
      className='min-w-[120px] flex-1 @4xl/plist:min-w-0'
      title={[geo.ip, geo.isp, note].filter(Boolean).join(' · ') || undefined}
    >
      <p className='truncate text-xs'>
        {country ? (
          <span className='font-medium tracking-[0.02em]'>{country}</span>
        ) : null}
        {country && geo.city ? (
          <span className='text-muted-foreground'> · </span>
        ) : null}
        {geo.city}
      </p>
      <p className='mt-0.5 truncate text-[11px] text-muted-foreground'>
        {[geo.timezone, note].filter(Boolean).join(' · ')}
      </p>
    </div>
  )
}

const BAR_H = [5, 8, 11]

function Latency({ proxy }: { proxy: VmProxySnap }) {
  const tone = proxyLatencyTone(proxy)
  const bars = proxySignalBars(proxy)
  const color =
    tone === 'caution'
      ? 'var(--status-caution-solid)'
      : 'var(--status-ok-solid)'
  return (
    <div className='flex items-end gap-1.5'>
      <span aria-hidden='true' className='flex items-end gap-[2px] pb-px'>
        {BAR_H.map((h, i) => (
          <span
            key={h}
            className={cn(
              'w-[3px] rounded-[1px]',
              i < bars ? null : 'track-recessed'
            )}
            style={{
              height: h,
              backgroundColor: i < bars ? color : undefined,
            }}
          />
        ))}
      </span>
      <span
        className={cn(
          'field-metric text-[13px] leading-none',
          proxyFieldClass(tone)
        )}
      >
        {proxy.latency_ms != null ? `${proxy.latency_ms}ms` : '—'}
      </span>
    </div>
  )
}
