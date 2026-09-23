import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

export const SEED_FLAGS: [string, string][] = [
  ['telemetry_disabled', '关闭遥测'],
  ['disable_nonessential_traffic', '关非必要流量'],
  ['do_not_track', 'DNT'],
  ['reject_client_settings', '拒客户端 settings'],
  ['reject_client_metadata_identity', '拒客户端身份'],
]

type SeedPolicy = Record<string, boolean>

export const SEED_PRESETS: Record<string, SeedPolicy> = {
  standard: {
    telemetry_disabled: false,
    disable_nonessential_traffic: true,
    do_not_track: false,
    reject_client_settings: true,
    reject_client_metadata_identity: true,
  },
  open: {
    telemetry_disabled: false,
    disable_nonessential_traffic: true,
    do_not_track: false,
    reject_client_settings: false,
    reject_client_metadata_identity: false,
  },
  strict: {
    telemetry_disabled: true,
    disable_nonessential_traffic: false,
    do_not_track: true,
    reject_client_settings: true,
    reject_client_metadata_identity: true,
  },
}

const PRESET_LABELS: [string, string, string][] = [
  ['standard', '标准', '拒客户端覆写，遥测开，非必要流量=1'],
  ['open', '开放', '不拒客户端；遥测开，非必要流量=1'],
  ['strict', '关闭遥测', '关遥测 + DNT；非必要流量=0'],
]

/**
 * Nonessential traffic is the inverse of the telemetry switch:
 * telemetry on → disable_nonessential_traffic true (env 1);
 * telemetry off → false (env 0). DNT still cannot stay on while telemetry is on.
 */
export function alignTelemetryDraft(draft: SeedPolicy): SeedPolicy {
  if (draft.telemetry_disabled) {
    return { ...draft, disable_nonessential_traffic: false }
  }
  return {
    ...draft,
    disable_nonessential_traffic: true,
    do_not_track: false,
  }
}

const TELEMETRY_LOCKED = new Set([
  'disable_nonessential_traffic',
  'do_not_track',
])

/**
 * 预设名 → 提交给后端的种子策略。`theme: 'dark'` 是 index.html `seedPolicyOf`
 * 里的固定值（非用户可选项），原样保留。
 */
export function seedPolicyOf(name: string): Record<string, boolean | string> {
  return { ...(SEED_PRESETS[name] || SEED_PRESETS.standard), theme: 'dark' }
}

export function matchSeedPreset(policy: Record<string, unknown>): string {
  for (const [name, preset] of Object.entries(SEED_PRESETS)) {
    if (SEED_FLAGS.every(([k]) => !!preset[k] === !!policy[k])) return name
  }
  return 'custom'
}

function normalize(policy: Record<string, unknown>): SeedPolicy {
  const out: SeedPolicy = {}
  for (const [k] of SEED_FLAGS) {
    out[k] = k in policy ? !!policy[k] : !!SEED_PRESETS.standard[k]
  }
  return out
}

export function SeedPolicyCard({
  policy,
  onSave,
  saving,
  syncTelemetry = true,
}: {
  policy: Record<string, unknown>
  onSave: (next: SeedPolicy) => void
  saving: boolean
  /** External official_cc.sync_telemetry. True means the next init turns telemetry back on. */
  syncTelemetry?: boolean
}) {
  const [draft, setDraft] = useState<SeedPolicy>(() =>
    alignTelemetryDraft(normalize(policy))
  )
  useEffect(() => {
    setDraft(alignTelemetryDraft(normalize(policy)))
  }, [policy])

  const current = matchSeedPreset(draft)
  const dirty = SEED_FLAGS.some(([k]) => !!draft[k] !== !!normalize(policy)[k])
  const telemetryOn = draft.telemetry_disabled !== true

  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>种子策略</CardTitle>
      </CardHeader>
      <CardContent className='space-y-4 pt-0'>
        <div className='space-y-2'>
          <div className='flex flex-wrap gap-2'>
            {PRESET_LABELS.map(([key, label, desc]) => (
              <Button
                key={key}
                size='sm'
                variant={current === key ? 'default' : 'outline'}
                aria-pressed={current === key}
                title={desc}
                disabled={saving}
                onClick={() =>
                  setDraft(alignTelemetryDraft({ ...SEED_PRESETS[key] }))
                }
              >
                {label}
              </Button>
            ))}
            {current === 'custom' ? (
              <Button size='sm' variant='secondary' disabled aria-pressed>
                自定义
              </Button>
            ) : null}
          </div>
          <p className='text-xs text-muted-foreground'>
            {current === 'custom'
              ? '当前组合不匹配任何预设。'
              : PRESET_LABELS.find(([k]) => k === current)?.[2]}
          </p>
        </div>

        <div className='space-y-2 border-t pt-3'>
          {SEED_FLAGS.map(([key, label]) => {
            const locked =
              key === 'disable_nonessential_traffic' ||
              (telemetryOn && TELEMETRY_LOCKED.has(key))
            return (
              <div
                key={key}
                className='flex items-center justify-between gap-3'
              >
                <Label htmlFor={`seed-${key}`} className='text-sm font-normal'>
                  {label}
                </Label>
                <Switch
                  id={`seed-${key}`}
                  checked={!!draft[key]}
                  disabled={saving || locked}
                  onCheckedChange={(v) => {
                    if (key === 'telemetry_disabled') {
                      setDraft(
                        alignTelemetryDraft({ ...draft, telemetry_disabled: v })
                      )
                      return
                    }
                    setDraft({ ...draft, [key]: v })
                  }}
                />
              </div>
            )
          })}
        </div>
        <p className='text-xs text-muted-foreground'>
          遥测打开时非必要流量固定为 1，DNT 关掉。遥测关闭时非必要流量固定为 0。
          {syncTelemetry
            ? ' 外部初装「同步遥测」开着，下次换票会按那份配置把本槽遥测重新打开。'
            : ' 外部初装「同步遥测」关着，换票不会改写这里的遥测开关。'}
        </p>

        <div className='flex gap-2 border-t pt-3'>
          <Button
            size='sm'
            disabled={saving || !dirty}
            onClick={() => onSave(alignTelemetryDraft(draft))}
          >
            {saving ? '写入中…' : '播种'}
          </Button>
          <Button
            size='sm'
            variant='ghost'
            disabled={saving || !dirty}
            onClick={() => setDraft(normalize(policy))}
          >
            重置
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
