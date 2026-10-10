import { useState, type ReactNode } from 'react'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import type { PreflightCheck } from '@/types/panel-cluster'
import type { RuntimeType } from '@/types/panel-vm'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { api, isApiError } from '@/lib/api'
import { importErrorMessage } from '@/lib/import-errors'
import { cn } from '@/lib/utils'
import { vmIdOf } from '@/lib/vm-name'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ChoiceTiles, Segmented } from '@/components/choice-tiles'
import { PlatformChip } from '@/components/platform-chip'
import { meQueryOptions } from '@/features/auth/queries'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  CreateExitField,
  useCreateExit,
  type CreateExit,
} from '@/features/vm/create-exit-field'
import {
  KERNELS,
  VM_CONCURRENCY_OPTIONS,
  VM_CREATE_AFTER,
  VM_LOCALES,
  VM_REGION_AUTO,
  VM_REGIONS,
  VM_TEMPLATES,
  VM_WEIGHT_OPTIONS,
  kernelProfile,
} from '@/features/vm/create-options'
import {
  TCG_WARNING,
  VM_DISK_GB_MAX,
  VM_DISK_GB_MIN,
  VM_MEMORY_LABELS,
  VM_MEMORY_OPTIONS,
  VM_VCPU_OPTIONS,
  createMachinePayload,
  isMemoryOption,
  kvmAvailabilityFromLocal,
  kvmAvailabilityFromPreflight,
  normalizeVmConfig,
  type KvmAvailability,
  type VmMemoryOption,
} from '@/features/vm/machine-spec'
import { preflightChecksFromError } from '@/features/vm/placement'
import {
  PlacementField,
  PreflightCheckList,
  usePlacement,
  type Placement,
} from '@/features/vm/placement-field'
import {
  vmCreateOptionsQueryOptions,
  vmsListQueryOptions,
} from '@/features/vm/queries'

/** 「之后」的 5 档，对齐 index.html `createVmFromPage()` 的派生逻辑。 */
export type CreateVmAfter = 'idle' | 'start' | 'proxy' | 'active' | 'full'

type Platform = 'anthropic' | 'openai'

type CreateVmResponse = {
  id?: string
  vm_id?: string
  vm?: { id?: string }
  start_error?: string
  /** 指定出口在创建瞬间没绑上（被别处占满等）。 */
  proxy_error?: string
}

/**
 * 「之后」→ 三个布尔的派生。index.html `createVmFromPage()`:
 *   start = after !== 'idle'
 *   auto_allocate_proxy = after === 'proxy' || after === 'full'
 *   activate = after === 'active' || after === 'full'
 */
function deriveAfter(after: string) {
  return {
    start: after !== 'idle',
    auto_allocate_proxy: after === 'proxy' || after === 'full',
    activate: after === 'active' || after === 'full',
  }
}

const MEMORY_SHORT: Record<VmMemoryOption, string> = {
  '512m': '512M',
  '1g': '1G',
  '2g': '2G',
  '4g': '4G',
  '8g': '8G',
  '16g': '16G',
}

type CreateVmResult = { id: string; startError: string; proxyError: string }

/** 创建表单的草稿：表单与规格单读同一份。 */
export interface CreateVmDraft {
  isAdmin: boolean
  pinnedAfter?: CreateVmAfter
  platform: Platform
  setPlatform: (next: Platform) => void
  kernel: string
  pickKernel: (next: string) => void
  name: string
  setName: (next: string) => void
  typedName: string
  after: string
  setAfter: (next: string) => void
  region: string
  setRegion: (next: string) => void
  locale: string
  setLocale: (next: string) => void
  conc: number
  setConc: (next: number) => void
  openaiOwnConc: boolean
  setOpenaiOwnConc: (next: boolean) => void
  openaiConc: number | null
  setOpenaiConc: (next: number | null) => void
  weight: number
  setWeight: (next: number) => void
  runtimeType: RuntimeType
  setRuntime: (next: RuntimeType) => void
  memory: string
  setMemory: (next: string) => void
  vcpus: number
  setVcpus: (next: number) => void
  diskGb: number
  setDiskGb: (next: number) => void
  placement: Placement
  kvmAvail: KvmAvailability
  /** 本机不支持 KVM：选项禁用，草稿回落容器。 */
  kvmBlocked: boolean
  remoteGpt: boolean
  exit: CreateExit
  wantsExit: boolean
  create: UseMutationResult<CreateVmResult, Error, void>
  /** 预检未过 / 远端 GPT / KVM 仍在检测：提交按钮禁用。 */
  blocked: boolean
  placementChecks: PreflightCheck[]
}

/**
 * 创建槽位的全部草稿状态 + 提交。表单与规格单是同一份草稿的两种呈现，
 * 所以状态放在外层，导入流程把规格单放右栏，弹窗把它省掉。
 *
 * pinnedAfter：传入即固定「之后」档位（导入流程用 idle，出口在下一步手选）。
 */
export function useCreateVmDraft({
  pinnedAfter,
  onCreated,
}: {
  pinnedAfter?: CreateVmAfter
  onCreated?: (id: string) => void
} = {}): CreateVmDraft {
  const qc = useQueryClient()
  const first = VM_TEMPLATES[0]
  const [platform, setPlatformState] = useState<Platform>('anthropic')
  const [kernel, setKernel] = useState<string>(first.kernel)
  const [name, setName] = useState('')
  const [after, setAfter] = useState<string>(pinnedAfter || first.after)
  const [region, setRegion] = useState<string>(first.region || VM_REGION_AUTO)
  const [locale, setLocale] = useState<string>(first.locale)
  const [conc, setConc] = useState<number>(first.conc)
  const [openaiOwnConc, setOpenaiOwnConc] = useState(false)
  const [openaiConc, setOpenaiConc] = useState<number | null>(null)
  const [weight, setWeight] = useState<number>(first.weight)
  const [runtimeOverride, setRuntimeOverride] = useState<RuntimeType | null>(
    null
  )
  const [memoryOverride, setMemoryOverride] = useState<string | null>(null)
  const [vcpusOverride, setVcpusOverride] = useState<number | null>(null)
  const [diskOverride, setDiskOverride] = useState<number | null>(null)

  const me = useQuery(meQueryOptions())
  const createOptions = useQuery(vmCreateOptionsQueryOptions())
  const vmCfg = normalizeVmConfig(createOptions.data?.vm)
  const preferredRuntime = runtimeOverride ?? vmCfg.default_runtime
  const memory = memoryOverride ?? vmCfg.memory
  const vcpus = vcpusOverride ?? vmCfg.vcpus
  const diskGb = diskOverride ?? vmCfg.disk_gb

  const typedName = name.trim()
  const placement = usePlacement(kernel, preferredRuntime)
  const kvmAvail: KvmAvailability = placement.nodeId
    ? kvmAvailabilityFromPreflight({
        fetching: placement.preflight.isFetching,
        error: placement.preflight.error,
        data: placement.preflight.data,
      })
    : kvmAvailabilityFromLocal({
        fetching: createOptions.isFetching,
        error: createOptions.error,
        kvm: createOptions.data?.kvm,
      })
  const kvmBlocked =
    !placement.nodeId &&
    (kvmAvail.status === 'disabled' || kvmAvail.status === 'unknown')
  // 宿主不支持时静默回落容器，不提交一个必然 409 的形态。
  const runtimeType: RuntimeType =
    preferredRuntime === 'kvm' && kvmBlocked ? 'docker' : preferredRuntime
  const kvmPending =
    runtimeType === 'kvm' && !placement.nodeId && kvmAvail.status === 'loading'
  const remoteGpt = !!placement.nodeId && platform === 'openai'
  const exit = useCreateExit(placement.nodeId)
  const wantsExit = after !== 'idle'

  function setPlatform(next: Platform) {
    setPlatformState(next)
    if (next === 'openai') {
      setOpenaiConc(null)
      setOpenaiOwnConc(false)
    }
  }

  function pickKernel(next: string) {
    // 系统与模板一一对应：选系统即套用它的区域 / 语言 / 并发预设。
    const tpl = VM_TEMPLATES.find((t) => t.kernel === next) || first
    setKernel(next)
    // 宿主钉死了「之后」（导入流程）时不跟模板走。
    setAfter(pinnedAfter || tpl.after)
    setRegion(tpl.region || VM_REGION_AUTO)
    setLocale(tpl.locale)
    setConc(tpl.conc)
    setOpenaiConc(null)
    setOpenaiOwnConc(false)
    setWeight(tpl.weight)
  }

  const create = useMutation({
    mutationFn: async () => {
      // 纯非 ASCII 名称（如「测试槽」）清洗后为空：不发 id，让后端自动编号。
      const id = typedName ? vmIdOf(typedName) || undefined : undefined
      const nodeId = placement.nodeId
      const data = await api<CreateVmResponse>('/api/panel/vms/create', {
        method: 'POST',
        body: JSON.stringify({
          id,
          ...(typedName ? { name: typedName } : {}),
          kernel,
          locale,
          // 「自动」是纯 UI 哨兵值，不发给后端。
          region: region === VM_REGION_AUTO ? undefined : region,
          ...(platform === 'openai'
            ? openaiOwnConc && openaiConc != null
              ? { max_concurrency: openaiConc }
              : {}
            : { max_concurrency: conc }),
          weight,
          ...deriveAfter(after),
          platform,
          family: platform === 'openai' ? 'codex' : 'claude',
          ...(nodeId ? { node_id: nodeId } : {}),
          ...(wantsExit && exit.proxyId ? { proxy_id: exit.proxyId } : {}),
          ...createMachinePayload({ runtimeType, memory, vcpus, diskGb }),
        }),
      })
      return {
        id: data.id || data.vm_id || data.vm?.id || id || '',
        startError: data.start_error || '',
        proxyError: data.proxy_error || '',
      }
    },
    onSuccess: async (created) => {
      if (created.proxyError) {
        toast.warning(`出口未绑定：${created.proxyError}`)
      }
      if (created.startError) {
        toast.warning(
          created.id
            ? `已创建 ${created.id}，开机失败：${created.startError}`
            : `已创建，开机失败：${created.startError}`
        )
      } else {
        toast.success(created.id ? `已创建 ${created.id}` : '已创建')
      }
      setName('')
      await Promise.all([
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
        qc.invalidateQueries({ queryKey: vmsListQueryOptions().queryKey }),
      ])
      // 拿不到 id 时不回调：导入流程会把空 id 当成取消选中。
      if (created.id) onCreated?.(created.id)
    },
    onError: (error: Error) => {
      toast.error(importErrorMessage(error))
      // 预检在提交前后可能变了（节点掉线 / 镜像被删），刷新一次让检查项同步。
      if (isApiError(error) && error.code === 'placement_preflight_failed') {
        void placement.preflight.refetch()
      }
    },
  })

  return {
    isAdmin: me.data?.role === 'admin',
    pinnedAfter,
    platform,
    setPlatform,
    kernel,
    pickKernel,
    name,
    setName,
    typedName,
    after,
    setAfter,
    region,
    setRegion,
    locale,
    setLocale,
    conc,
    setConc,
    openaiOwnConc,
    setOpenaiOwnConc,
    openaiConc,
    setOpenaiConc,
    weight,
    setWeight,
    runtimeType,
    setRuntime: (next: RuntimeType) => setRuntimeOverride(next),
    memory,
    setMemory: (next: string) => {
      if (isMemoryOption(next)) setMemoryOverride(next)
    },
    vcpus,
    setVcpus: (n: number) => setVcpusOverride(n),
    diskGb,
    setDiskGb: (n: number) =>
      setDiskOverride(
        Math.min(VM_DISK_GB_MAX, Math.max(VM_DISK_GB_MIN, Math.round(n)))
      ),
    placement,
    kvmAvail,
    kvmBlocked,
    remoteGpt,
    exit,
    wantsExit,
    create,
    blocked: placement.blocked || remoteGpt || kvmPending,
    placementChecks: preflightChecksFromError(create.error),
  }
}

/** 规格的一句话：容器只读内存；KVM 带 vCPU 与磁盘。 */
export function machineLine(
  runtime: RuntimeType,
  memory?: string,
  vcpus?: number,
  diskGb?: number
): string {
  const mem = memory
    ? VM_MEMORY_LABELS[memory as VmMemoryOption] || memory
    : '默认内存'
  if (runtime !== 'kvm') return `${mem} 内存`
  return [mem, vcpus ? `${vcpus} vCPU` : null, diskGb ? `${diskGb} GB` : null]
    .filter(Boolean)
    .join(' · ')
}

export type SpecRow = { label: string; value: ReactNode }

/** 右栏规格单：标签左、值右，数值等宽对齐。 */
export function SpecSheet({
  rows,
  className,
}: {
  rows: SpecRow[]
  className?: string
}) {
  return (
    <dl
      className={cn('grid grid-cols-[4.5rem_minmax(0,1fr)] gap-y-2', className)}
    >
      {rows.map((r) => (
        <div key={r.label} className='contents'>
          <dt className='text-xs leading-5 text-muted-foreground'>{r.label}</dt>
          <dd className='min-w-0 text-sm leading-5 break-words tabular-nums'>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function draftSpecRows(d: CreateVmDraft): SpecRow[] {
  const node = d.placement.nodeId
    ? d.placement.nodes.find((n) => n.id === d.placement.nodeId)
    : null
  return [
    {
      label: '平台',
      value: (
        <PlatformChip kind={d.platform === 'openai' ? 'codex' : 'claude'} />
      ),
    },
    {
      label: '形态',
      value:
        d.runtimeType === 'kvm'
          ? d.kvmAvail.status === 'ok' && d.kvmAvail.accel === 'tcg'
            ? '虚拟机 (KVM · TCG)'
            : '虚拟机 (KVM)'
          : '容器 (Docker)',
    },
    { label: '系统', value: kernelProfile(d.kernel)?.name || d.kernel },
    {
      label: '规格',
      value: machineLine(d.runtimeType, d.memory, d.vcpus, d.diskGb),
    },
    {
      label: '放置',
      value: node ? node.label || node.host : '本机',
    },
    {
      label: '名称',
      value: d.typedName || (
        <span className='text-muted-foreground'>自动编号</span>
      ),
    },
  ]
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className='space-y-3 border-t pt-5 first:border-t-0 first:pt-0'>
      <div className='space-y-0.5'>
        <div className='flex items-baseline justify-between gap-3'>
          <h4 className='text-sm font-semibold'>{title}</h4>
          {action}
        </div>
        {hint ? (
          <p className='text-xs leading-relaxed text-muted-foreground'>
            {hint}
          </p>
        ) : null}
      </div>
      {children}
    </section>
  )
}

function kvmDetail(avail: KvmAvailability, remote: boolean): ReactNode {
  if (avail.status === 'loading') return '正在检测宿主 KVM…'
  if (avail.status === 'disabled' || avail.status === 'unknown') {
    return remote ? `节点：${avail.reason}` : avail.reason
  }
  if (avail.accel === 'tcg') {
    return (
      <span className='text-[color:var(--status-caution)]'>{TCG_WARNING}</span>
    )
  }
  return '独立内核与硬件指纹（SMBIOS、MAC、磁盘序列号），需宿主 /dev/kvm。'
}

/**
 * 创建槽位的表单。顺序即决策顺序：先定账号平台与机器形态，
 * 再定系统与规格，最后才是放置与名称这类可以不管的项。
 *
 * variant=flow：导入流程第 1 步，规格单在页面右栏，按钮是「创建空槽」。
 * variant=dialog：槽位页快捷创建，多一节「创建后」，带取消。
 */
export function CreateVmForm({
  draft: d,
  variant,
  onCancel,
}: {
  draft: CreateVmDraft
  variant: 'flow' | 'dialog'
  onCancel?: () => void
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const remote = !!d.placement.nodeId
  const kvm = d.runtimeType === 'kvm'

  return (
    <div className='space-y-5'>
      <Section title='平台' hint='决定槽里跑哪种账号，创建后不能改。'>
        <ChoiceTiles
          label='槽位平台'
          value={d.platform}
          onChange={d.setPlatform}
          choices={[
            {
              value: 'anthropic',
              title: <PlatformChip kind='claude' />,
              detail: 'OAuth、Setup Token 或 Console Key，可跑官方初装。',
            },
            {
              value: 'openai',
              title: <PlatformChip kind='codex' />,
              detail: 'Codex OAuth 或 auth.json。只能放在本机。',
            },
          ]}
        />
      </Section>

      <Section title='形态' hint='容器轻、快；虚拟机给每个槽一台独立的机器。'>
        <ChoiceTiles
          label='槽位形态'
          value={d.runtimeType}
          onChange={d.setRuntime}
          choices={[
            {
              value: 'docker',
              title: '容器 (Docker)',
              detail: '共享宿主内核，秒级开机。规格只读内存。',
            },
            {
              value: 'kvm',
              title: '虚拟机 (KVM)',
              detail: kvmDetail(d.kvmAvail, remote),
              disabled: d.kvmBlocked,
            },
          ]}
        />
      </Section>

      <Section title='系统' hint='选系统同时套用它的区域、语言与并发预设。'>
        <ChoiceTiles
          label='客体系统'
          value={d.kernel}
          onChange={d.pickKernel}
          className='grid-cols-2 lg:grid-cols-4'
          choices={KERNELS.map((k) => ({
            value: k.id,
            title: k.name,
            detail: k.feats.slice(0, 2).join(' · '),
          }))}
        />
      </Section>

      <Section
        title='规格'
        hint={
          kvm
            ? '固化到槽位，开机后不变。'
            : '容器只用内存上限；vCPU 与磁盘只对虚拟机生效。'
        }
        action={
          d.isAdmin ? (
            <Link
              to='/specs'
              className='text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline'
            >
              修改默认值
            </Link>
          ) : null
        }
      >
        <div className='flex flex-wrap items-end gap-x-6 gap-y-3'>
          <div className='space-y-1.5'>
            <Label id='vm-memory-label'>内存</Label>
            <Segmented
              label='槽位内存'
              value={d.memory as VmMemoryOption}
              onChange={d.setMemory}
              options={VM_MEMORY_OPTIONS.map((id) => ({
                value: id,
                label: MEMORY_SHORT[id],
              }))}
            />
          </div>
          {kvm ? (
            <>
              <div className='space-y-1.5'>
                <Label htmlFor='vm-vcpus'>vCPU</Label>
                <Select
                  value={String(d.vcpus)}
                  onValueChange={(v) => d.setVcpus(Number(v))}
                >
                  <SelectTrigger
                    id='vm-vcpus'
                    className='w-24'
                    aria-label='槽位 vCPU'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VM_VCPU_OPTIONS.map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='vm-disk'>磁盘</Label>
                <div className='flex items-center gap-1.5'>
                  <Input
                    id='vm-disk'
                    type='number'
                    className='w-24 tabular-nums'
                    min={VM_DISK_GB_MIN}
                    max={VM_DISK_GB_MAX}
                    value={d.diskGb}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      if (Number.isFinite(n)) d.setDiskGb(n)
                    }}
                  />
                  <span className='text-sm text-muted-foreground'>GB</span>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </Section>

      {d.placement.visible ? (
        <Section title='放置' hint='放到集群节点前会先预检。'>
          <PlacementField
            placement={d.placement}
            kernel={d.kernel}
            gptBlocked={d.remoteGpt}
            runtimeType={d.runtimeType}
          />
        </Section>
      ) : null}

      <Section title='名称'>
        <div className='space-y-1.5'>
          <Input
            aria-label='槽位名称'
            value={d.name}
            onChange={(e) => d.setName(e.target.value)}
            placeholder='留空自动编号，如 vm-08'
            className='max-w-sm'
          />
        </div>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger className='inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground'>
            区域、语言、并发与权重
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform duration-150',
                moreOpen && 'rotate-180'
              )}
              aria-hidden='true'
            />
          </CollapsibleTrigger>
          <CollapsibleContent className='grid gap-3 pt-3 sm:grid-cols-2'>
            <Field label='区域'>
              <Select value={d.region} onValueChange={d.setRegion}>
                <SelectTrigger aria-label='区域'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VM_REGIONS.map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label='语言'>
              <Select value={d.locale} onValueChange={d.setLocale}>
                <SelectTrigger aria-label='语言'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VM_LOCALES.map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {d.platform === 'openai' ? (
              <Field label='OpenAI 并发'>
                <div className='flex h-9 items-center gap-2'>
                  <Switch
                    checked={d.openaiOwnConc}
                    onCheckedChange={(checked) => {
                      d.setOpenaiOwnConc(checked)
                      d.setOpenaiConc(checked ? d.conc : null)
                    }}
                    aria-label='使用独立 OpenAI 并发'
                  />
                  {d.openaiOwnConc ? (
                    <Select
                      value={String(d.openaiConc ?? d.conc)}
                      onValueChange={(v) => d.setOpenaiConc(Number(v))}
                    >
                      <SelectTrigger className='w-24' aria-label='OpenAI 并发'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {VM_CONCURRENCY_OPTIONS.filter((v) => v > 0).map(
                          (v) => (
                            <SelectItem key={v} value={String(v)}>
                              {v}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className='text-xs text-muted-foreground'>
                      跟随 OpenAI 全局默认
                    </span>
                  )}
                </div>
              </Field>
            ) : (
              <Field label='并发'>
                <Select
                  value={String(d.conc)}
                  onValueChange={(v) => d.setConc(Number(v))}
                >
                  <SelectTrigger aria-label='并发'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VM_CONCURRENCY_OPTIONS.map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field label='权重'>
              <Select
                value={String(d.weight)}
                onValueChange={(v) => d.setWeight(Number(v))}
              >
                <SelectTrigger aria-label='权重'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VM_WEIGHT_OPTIONS.map((v) => (
                    <SelectItem key={v} value={String(v)}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <p className='text-xs leading-relaxed text-muted-foreground sm:col-span-2'>
              时区不在这里选：绑定 SOCKS5 并完成地理探测后自动写入。
            </p>
          </CollapsibleContent>
        </Collapsible>
      </Section>

      {variant === 'dialog' && !d.pinnedAfter ? (
        <Section title='创建后'>
          <Field label='接着做'>
            <Select value={d.after} onValueChange={d.setAfter}>
              <SelectTrigger aria-label='创建后'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_CREATE_AFTER.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {d.wantsExit ? (
            <CreateExitField exit={d.exit} remote={remote} />
          ) : null}
        </Section>
      ) : null}

      {d.placementChecks.length ? (
        <div className='space-y-1 rounded-lg border border-[color:var(--status-bad)]/40 p-3'>
          <p className='text-xs text-[color:var(--status-bad)]'>
            目标节点预检未通过：
          </p>
          <PreflightCheckList checks={d.placementChecks} />
        </div>
      ) : null}

      {variant === 'flow' ? (
        <SpecSheet
          rows={draftSpecRows(d)}
          className='rounded-lg border bg-muted/30 p-3 lg:hidden'
        />
      ) : null}

      <div className='flex flex-wrap items-center justify-end gap-2 border-t pt-4'>
        {d.create.error ? (
          <p className='me-auto text-xs text-[color:var(--status-bad)]'>
            {importErrorMessage(d.create.error)}
          </p>
        ) : variant === 'flow' ? (
          <p className='me-auto text-xs text-muted-foreground'>
            创建后在下面绑出口、导入账号。
          </p>
        ) : null}
        {onCancel ? (
          <Button variant='outline' onClick={onCancel}>
            取消
          </Button>
        ) : null}
        <Button
          onClick={() => d.create.mutate()}
          disabled={d.create.isPending || d.blocked}
          loading={d.create.isPending}
        >
          {variant === 'flow' ? '创建空槽' : '创建'}
        </Button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='space-y-1.5'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}
