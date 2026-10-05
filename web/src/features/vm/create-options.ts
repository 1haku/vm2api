export type KernelCapability = 'linux' | 'macos' | 'unknown'
export type KernelSupport =
  'supported' | 'candidate' | 'unavailable' | 'unknown'

/** 候选发行版不等同于已通过部署认证。 */
export const CANDIDATE_SMOKE_NOTE = '候选发行版，部署未认证'

/**
 * macOS 只作为 x86_64 KVM 候选展示。未满足宿主、许可、初始化和 Darwin 产物前不可创建。
 * 不提供 Windows，也不提供 Apple Silicon。
 */
export const MACOS_KVM_UNAVAILABLE =
  '需要已授权的 KVM 宿主、已审核的许可、完成的系统初始化，以及 Darwin 槽位产物'

export type KernelProfile = {
  id: string
  name: string
  base: string
  size: string
  feats: string[]
  capability: KernelCapability
  support: KernelSupport
  /** 目录已收录且允许发到集群节点。候选在收录前必须保持 false。 */
  remoteSupported: boolean
  arch?: string
  unavailableReason?: string
}

function linuxProfile(
  profile: Omit<
    KernelProfile,
    'capability' | 'support' | 'remoteSupported' | 'arch'
  > & { support?: 'supported' | 'candidate' }
): KernelProfile {
  const support = profile.support || 'supported'
  return {
    ...profile,
    capability: 'linux',
    support,
    remoteSupported: support === 'supported',
    arch: 'x86_64',
  }
}

export const KERNELS: KernelProfile[] = [
  linuxProfile({
    id: 'ubuntu-24.04',
    name: 'Ubuntu 24.04',
    base: 'kin-os/ubuntu:24.04',
    size: '标准机',
    feats: ['LTS', 'apt', 'cli-hop wrap/crag', 'host-net'],
  }),
  linuxProfile({
    id: 'debian-12',
    name: 'Debian 12',
    base: 'kin-os/debian:12',
    size: '标准机',
    feats: ['glibc', 'apt', 'cli-hop wrap/crag', 'host-net'],
  }),
  linuxProfile({
    id: 'archlinux',
    name: 'Arch Linux',
    base: 'kin-os/arch:latest',
    size: '标准机',
    feats: ['rolling', 'pacman', 'cli-hop wrap/crag', 'host-net'],
  }),
  linuxProfile({
    id: 'fedora-41',
    name: 'Fedora 41',
    base: 'kin-os/fedora:41',
    size: '标准机',
    feats: ['dnf', 'glibc', 'cli-hop wrap/crag', 'host-net'],
  }),
  linuxProfile({
    id: 'debian-13',
    name: 'Debian 13',
    base: '',
    size: '候选',
    support: 'candidate',
    feats: [CANDIDATE_SMOKE_NOTE],
  }),
  linuxProfile({
    id: 'ubuntu-26.04',
    name: 'Ubuntu 26.04',
    base: '',
    size: '候选',
    support: 'candidate',
    feats: [CANDIDATE_SMOKE_NOTE],
  }),
  linuxProfile({
    id: 'fedora-44',
    name: 'Fedora 44',
    base: '',
    size: '候选',
    support: 'candidate',
    feats: [CANDIDATE_SMOKE_NOTE],
  }),
  {
    id: 'macos-15',
    name: 'macOS 15',
    base: '',
    size: 'x86_64',
    feats: [],
    capability: 'macos',
    support: 'unavailable',
    remoteSupported: false,
    arch: 'x86_64',
    unavailableReason: MACOS_KVM_UNAVAILABLE,
  },
  {
    id: 'macos-14',
    name: 'macOS 14',
    base: '',
    size: 'x86_64',
    feats: [],
    capability: 'macos',
    support: 'unavailable',
    remoteSupported: false,
    arch: 'x86_64',
    unavailableReason: MACOS_KVM_UNAVAILABLE,
  },
]

export function kernelProfile(id?: string | null): KernelProfile | null {
  const k = String(id || '').trim()
  const known = KERNELS.find((x) => x.id === k)
  if (known) return known
  if (!k) return null
  return {
    id: k,
    name: k,
    base: '',
    size: '',
    feats: [],
    capability: 'unknown',
    support: 'unknown',
    remoteSupported: false,
    unavailableReason: '未登记的客体系统，不能当作已支持的 Linux',
  }
}

/** 只有已支持系统和本机候选能被选中。不可用项留在列表里，但提交不接受。 */
export function kernelSelectable(profile: KernelProfile | null | undefined) {
  return profile?.support === 'supported' || profile?.support === 'candidate'
}

export function kernelOptionLabel(profile: KernelProfile) {
  return profile.size ? `${profile.name} · ${profile.size}` : profile.name
}

/**
 * 创建提交前的客体系统拦截。返回可展示的原因；`null` 表示可以提交。
 * 远端候选保持拦截，直到目录明确收录（`remoteSupported`）。
 */
export function kernelCreateBlock(
  id: string | null | undefined,
  remote: boolean
): string | null {
  const profile = kernelProfile(id)
  if (!profile) return '请选择客体系统'
  if (!kernelSelectable(profile) || profile.capability === 'macos') {
    return profile.unavailableReason || '该客体系统当前不可创建'
  }
  if (remote && !profile.remoteSupported) {
    return '远端节点暂不接受该候选客体系统。请改在本机创建，或改用已支持的 Ubuntu 24.04、Debian 12、Arch、Fedora 41。'
  }
  return null
}

/** 准备状态。未知值不能显示成就绪。 */
export const PROVISION_STATES = [
  'planned',
  'admitted',
  'image_ready',
  'needs_setup',
  'provisioning_os',
  'os_ready',
  'verifying_hardware',
  'provisioning_worker',
  'slot_ready',
  'failed',
  'cancelled',
  'stopping',
  'stopped',
  'draining',
] as const

export type ProvisionState = (typeof PROVISION_STATES)[number]

const PROVISION_STATE_LABEL: Record<ProvisionState, string> = {
  planned: '已计划',
  admitted: '已准入',
  image_ready: '镜像就绪',
  needs_setup: '待完成系统初始化',
  provisioning_os: '正在准备客体系统',
  os_ready: '客体系统就绪',
  verifying_hardware: '正在核对硬件',
  provisioning_worker: '正在准备推理工件',
  slot_ready: '推理槽就绪',
  failed: '失败',
  cancelled: '已取消',
  stopping: '正在停止',
  stopped: '已停止',
  draining: '正在排空',
}

export function provisionStateView(state: unknown): {
  label: string
  known: boolean
  hint?: string
} {
  const raw = String(state ?? '').trim()
  if (!raw) return { label: '', known: false }
  if ((PROVISION_STATES as readonly string[]).includes(raw)) {
    return {
      label: PROVISION_STATE_LABEL[raw as ProvisionState],
      known: true,
      hint: raw === 'os_ready' ? '客体系统已就绪，推理槽尚未就绪' : undefined,
    }
  }
  return { label: `未知 / ${raw}`, known: false }
}

/** 创建槽位的模板预设，与 index.html `VM_TEMPLATES` 一致。 */
export const VM_TEMPLATES = [
  {
    id: 'std-ubuntu',
    name: '标准 Ubuntu',
    kernel: 'ubuntu-24.04',
    after: 'start',
    region: 'us-west',
    tz: 'America/Los_Angeles',
    locale: 'en_US.UTF-8',
    conc: 2,
    weight: 1,
  },
  {
    id: 'std-debian',
    name: '标准 Debian',
    kernel: 'debian-12',
    after: 'start',
    region: 'us-east',
    tz: 'America/New_York',
    locale: 'en_US.UTF-8',
    conc: 2,
    weight: 1,
  },
  {
    id: 'std-arch',
    name: '标准 Arch',
    kernel: 'archlinux',
    after: 'start',
    region: 'us-central',
    tz: 'America/Chicago',
    locale: 'en_US.UTF-8',
    conc: 2,
    weight: 1,
  },
  {
    id: 'std-fedora',
    name: '标准 Fedora',
    kernel: 'fedora-41',
    after: 'start',
    region: 'us-west',
    tz: 'America/Denver',
    locale: 'en_US.UTF-8',
    conc: 2,
    weight: 1,
  },
] as const

/**
 * 「自动选区」的哨兵值。不能直接用空串：Radix `Select` 把 `value === ''` 当作
 * 「未选中」并渲染 placeholder，空串选项永远无法在 trigger 上显示出文案。
 * 提交时由调用方映射回 `undefined`。
 */
export const VM_REGION_AUTO = 'auto'

/**
 * 创建槽位「高级」区的区域选项。
 * `us-central` 是 `VM_TEMPLATES.std-arch` 的预设值，index.html 的下拉里漏了它
 * （原生 select 会静默退回首项显示「自动」却仍提交 us-central），这里补齐，
 * 否则选中 Arch 模板后区域框会显示空白。
 */
export const VM_REGIONS: [string, string][] = [
  [VM_REGION_AUTO, '自动'],
  ['us-west', '美西'],
  ['us-central', '美中'],
  ['us-east', '美东'],
  ['eu-west', '欧洲'],
  ['ap-east', '亚太东'],
  ['ap-southeast', '亚太东南'],
]

/**
 * 「自定义」的哨兵值，与 `VM_REGION_AUTO` 同理：Radix `Select` 不接受空串选项。
 * 选中它时由调用方渲染输入框，提交的是输入框里的 IANA 名称。
 * 不能写成某个真实时区，否则自定义输入被清空时会静默提交这个时区。
 */
export const VM_TIMEZONE_CUSTOM = '__custom__'

/**
 * 环境时区预设。后端只校验 IANA 可解析（`validTimezone()`），不限美国区，
 * 所以这里是覆盖常见出口地区的快捷入口，真正的兜底是「自定义」。
 */
export const VM_TIMEZONES: [string, string][] = [
  ['America/Los_Angeles', '洛杉矶 PT'],
  ['America/Denver', '丹佛 MT'],
  ['America/Chicago', '芝加哥 CT'],
  ['America/New_York', '纽约 ET'],
  ['America/Sao_Paulo', '圣保罗 BRT'],
  ['Europe/London', '伦敦 GMT/BST'],
  ['Europe/Paris', '巴黎 CET'],
  ['Europe/Berlin', '柏林 CET'],
  ['Europe/Moscow', '莫斯科 MSK'],
  ['Asia/Dubai', '迪拜 GST'],
  ['Asia/Kolkata', '加尔各答 IST'],
  ['Asia/Bangkok', '曼谷 ICT'],
  ['Asia/Shanghai', '上海 CST'],
  ['Asia/Hong_Kong', '香港 HKT'],
  ['Asia/Taipei', '台北 CST'],
  ['Asia/Singapore', '新加坡 SGT'],
  ['Asia/Seoul', '首尔 KST'],
  ['Asia/Tokyo', '东京 JST'],
  ['Australia/Sydney', '悉尼 AEST'],
  ['UTC', 'UTC'],
  [VM_TIMEZONE_CUSTOM, '自定义…'],
]

/** 预设里是否已有这个时区（决定下拉该选预设项还是「自定义」）。 */
export function isPresetTimezone(value: string): boolean {
  return VM_TIMEZONES.some(([id]) => id === value && id !== VM_TIMEZONE_CUSTOM)
}

export const VM_LOCALES: [string, string][] = [
  ['en_US.UTF-8', 'English'],
  ['zh_CN.UTF-8', '中文'],
  ['ja_JP.UTF-8', '日本語'],
  ['C.UTF-8', 'C'],
]

export const VM_CONCURRENCY_OPTIONS = [1, 2, 4, 8, 16, 20, 32]
export const VM_WEIGHT_OPTIONS = [1, 2, 3, 5]

/** 创建槽位「之后」的 5 档，决定 start / auto_allocate_proxy / activate 三个布尔。 */
export const VM_CREATE_AFTER: [string, string][] = [
  ['idle', '仅创建'],
  ['start', '开机'],
  ['proxy', '开机 + 分配出口'],
  ['active', '开机 + 活跃'],
  ['full', '开机 + 分配出口 + 活跃'],
]
