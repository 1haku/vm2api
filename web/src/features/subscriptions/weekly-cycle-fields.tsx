import type { Vm } from '@/types/panel-vm'

export type WeeklyCycleDraft = {
  weekly_reset_mode: string
  weekly_reset_vm_id: string | null
}
export function WeeklyCycleFields({
  value,
  slots,
  platform,
  onChange,
}: {
  value: WeeklyCycleDraft
  slots: Vm[]
  platform: string
  onChange: (patch: WeeklyCycleDraft) => void
}) {
  const slot = slots.find((s) => s.id === value.weekly_reset_vm_id)
  const raw = slot?.reset_7d
  const ms =
    raw && /^\d+$/.test(String(raw))
      ? Number(raw) * (Number(raw) < 1e12 ? 1000 : 1)
      : Date.parse(String(raw))
  const fresh = Number.isFinite(ms) && ms > Date.now()
  return (
    <fieldset className='space-y-3 rounded-lg border p-3'>
      <label className='grid gap-2 text-sm'>
        周额度周期
        <select
          className='h-9 rounded-md border bg-background px-3'
          value={value.weekly_reset_mode}
          onChange={(e) =>
            onChange({
              weekly_reset_mode: e.target.value,
              weekly_reset_vm_id:
                e.target.value === 'slot'
                  ? slots.length === 1
                    ? slots[0].id
                    : null
                  : null,
            })
          }
        >
          <option value='independent'>独立周期（每位用户 7 天）</option>
          <option value='slot' disabled={platform !== 'claude'}>
            跟随指定 Claude 槽位的官方周窗口
          </option>
        </select>
      </label>
      {value.weekly_reset_mode === 'slot' && (
        <>
          <label className='grid gap-2 text-sm'>
            参考槽位
            <select
              required
              className='h-9 rounded-md border bg-background px-3'
              value={value.weekly_reset_vm_id || ''}
              onChange={(e) =>
                onChange({
                  ...value,
                  weekly_reset_vm_id: e.target.value || null,
                })
              }
            >
              <option value=''>请选择已绑定的槽位</option>
              {slots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}
                </option>
              ))}
            </select>
          </label>
          <p className='text-xs text-muted-foreground'>
            {fresh
              ? `官方下次重置：${new Date(ms).toLocaleString('zh-CN')}（当前浏览器时区）`
              : '请先在槽位页查询限额，获取有效的官方周重置时间。'}
          </p>
          <p className='text-xs text-muted-foreground'>
            同套餐用户共用这个周时间边界，额度仍各自计算。切换后按官方当前窗口重算历史用量，不清空账本；手动清零用量不改变官方重置时间。多个槽位时仅所选槽位决定周期。
          </p>
        </>
      )}
    </fieldset>
  )
}
