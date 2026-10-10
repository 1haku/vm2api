import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { SettingRow } from '@/components/setting-row'
import {
  TCG_WARNING,
  VM_CPU_MODEL_LABELS,
  VM_CPU_MODELS,
  VM_DISK_GB_MAX,
  VM_DISK_GB_MIN,
  VM_MEMORY_LABELS,
  VM_MEMORY_OPTIONS,
  VM_VCPU_OPTIONS,
  isCpuModel,
  isMemoryOption,
  normalizeVmConfig,
  vmConfigFieldErrors,
} from '@/features/vm/machine-spec'

type Obj = Record<string, unknown>

export function VmPane({
  value,
  onChange,
}: {
  value: Obj | undefined
  onChange: (next: Obj) => void
}) {
  const config = normalizeVmConfig(value)
  const errors = vmConfigFieldErrors({
    ...config,
    mac_oui: value && 'mac_oui' in value ? value.mac_oui : config.mac_oui,
    vcpus: value && 'vcpus' in value ? value.vcpus : config.vcpus,
    disk_gb: value && 'disk_gb' in value ? value.disk_gb : config.disk_gb,
  })
  const macValue =
    value && typeof value.mac_oui === 'string' ? value.mac_oui : config.mac_oui
  const diskValue =
    value && 'disk_gb' in value && value.disk_gb != null
      ? String(value.disk_gb)
      : String(config.disk_gb)

  const set = (patch: Obj) => {
    const smbiosPatch = patch.smbios
    onChange({
      ...config,
      ...value,
      ...patch,
      smbios: {
        ...config.smbios,
        ...(typeof smbiosPatch === 'object' && smbiosPatch
          ? (smbiosPatch as Obj)
          : {}),
      },
    })
  }

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>虚拟机</CardTitle>
      </CardHeader>
      <CardContent className='space-y-3'>
        <p className='text-xs text-muted-foreground'>
          规格在创建时固化到槽位，修改只影响之后创建的槽；Docker 槽只使用内存。
        </p>

        <div className='divide-y'>
          <SettingRow
            label='默认形态'
            desc='导入页与创建表单的初始选项。宿主不支持 KVM 时仍会回落到容器。'
          >
            <Select
              value={config.default_runtime}
              onValueChange={(next) => {
                if (next === 'docker' || next === 'kvm') {
                  set({ default_runtime: next })
                }
              }}
            >
              <SelectTrigger className='w-44' aria-label='默认形态'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='docker'>容器 (Docker)</SelectItem>
                <SelectItem value='kvm'>虚拟机 (KVM)</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label='内存' desc='Docker 与 KVM 槽都读这项。'>
            <Select
              value={config.memory}
              onValueChange={(next) => {
                if (isMemoryOption(next)) set({ memory: next })
              }}
            >
              <SelectTrigger className='w-44' aria-label='默认内存'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_MEMORY_OPTIONS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {VM_MEMORY_LABELS[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>

          <SettingRow label='vCPU' desc='仅 KVM 槽使用，范围 1–16。'>
            <div className='space-y-1'>
              <Select
                value={String(config.vcpus)}
                onValueChange={(next) => set({ vcpus: Number(next) })}
              >
                <SelectTrigger className='w-44' aria-label='默认 vCPU'>
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
              {errors.vcpus ? (
                <p className='text-xs text-[color:var(--status-bad)]'>
                  {errors.vcpus}
                </p>
              ) : null}
            </div>
          </SettingRow>

          <SettingRow
            label='磁盘 GB'
            desc={`仅 KVM 槽使用，范围 ${VM_DISK_GB_MIN}–${VM_DISK_GB_MAX}。`}
          >
            <div className='space-y-1'>
              <Input
                className='w-44'
                type='number'
                min={VM_DISK_GB_MIN}
                max={VM_DISK_GB_MAX}
                value={diskValue}
                onChange={(e) => {
                  const raw = e.target.value
                  set({ disk_gb: raw === '' ? raw : Number(raw) })
                }}
                aria-invalid={!!errors.disk_gb}
                aria-label='默认磁盘 GB'
              />
              {errors.disk_gb ? (
                <p className='text-xs text-[color:var(--status-bad)]'>
                  {errors.disk_gb}
                </p>
              ) : null}
            </div>
          </SettingRow>

          <SettingRow
            label='CPU 型号'
            desc='仅 KVM。host 把宿主 CPU 透传给客户机。'
          >
            <Select
              value={config.cpu_model}
              onValueChange={(next) => {
                if (isCpuModel(next)) set({ cpu_model: next })
              }}
            >
              <SelectTrigger className='w-56' aria-label='CPU 型号'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VM_CPU_MODELS.map((id) => (
                  <SelectItem key={id} value={id}>
                    {VM_CPU_MODEL_LABELS[id]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        </div>

        <div className='space-y-2'>
          <Label>SMBIOS</Label>
          <p className='text-xs text-muted-foreground'>
            写入客户机 DMI。每槽还会再生成独立的序列号与 UUID。
          </p>
          <div className='grid gap-3 sm:grid-cols-2'>
            {(
              [
                ['manufacturer', '厂商', config.smbios.manufacturer],
                ['product', '型号', config.smbios.product],
                ['version', '版本', config.smbios.version],
                ['family', '系列', config.smbios.family],
              ] as const
            ).map(([key, label, current]) => (
              <div key={key} className='space-y-1'>
                <Label htmlFor={`vm-smbios-${key}`} className='text-xs'>
                  {label}
                </Label>
                <Input
                  id={`vm-smbios-${key}`}
                  value={current}
                  onChange={(e) => set({ smbios: { [key]: e.target.value } })}
                />
              </div>
            ))}
          </div>
        </div>

        <div className='space-y-1'>
          <Label htmlFor='vm-mac-oui'>MAC 前缀</Label>
          <Input
            id='vm-mac-oui'
            className='w-44 font-mono'
            placeholder='52:54:00'
            value={macValue}
            onChange={(e) => set({ mac_oui: e.target.value })}
            aria-invalid={!!errors.mac_oui}
          />
          {errors.mac_oui ? (
            <p className='text-xs text-[color:var(--status-bad)]'>
              {errors.mac_oui}
            </p>
          ) : (
            <p className='text-xs text-muted-foreground'>
              三位十六进制，形如 52:54:00。后三字节每槽随机。
            </p>
          )}
        </div>

        <div className='divide-y border-t pt-1'>
          <SettingRow
            label='允许 TCG 软件模拟'
            desc='无 /dev/kvm 时用 QEMU TCG 跑虚拟机。生产不要开。'
          >
            <Switch
              checked={config.allow_tcg}
              onCheckedChange={(checked) => set({ allow_tcg: checked })}
              aria-label='允许 TCG 软件模拟'
            />
          </SettingRow>
        </div>
        {config.allow_tcg ? (
          <p className='text-xs text-[color:var(--status-caution)]'>
            {TCG_WARNING}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
