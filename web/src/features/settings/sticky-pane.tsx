import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type StickyPaneProps = {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

export function StickyPane({ value: sticky, onChange }: StickyPaneProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>粘性</CardTitle>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow label='启用' desc='同一来源的请求在 TTL 内固定回同一账号'>
          <Switch
            checked={sticky.enabled !== false}
            onCheckedChange={(enabled) => onChange({ ...sticky, enabled })}
          />
        </SettingRow>
        <SettingRow label='模式'>
          <Select
            value={String(sticky.mode || 'conversation')}
            onValueChange={(mode) => onChange({ ...sticky, mode })}
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='conversation'>会话</SelectItem>
              <SelectItem value='session'>登录态</SelectItem>
              <SelectItem value='ip'>IP</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow
          label='出站 session'
          desc='重建：入站 session 只作调度身份，出站由网关赋值。透传会把客户端 session 原样发给上游。'
        >
          <Select
            value={String(sticky.outbound_session || 'rebuild')}
            onValueChange={(outboundSession) =>
              onChange({ ...sticky, outbound_session: outboundSession })
            }
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='rebuild'>重建</SelectItem>
              <SelectItem value='passthrough'>透传</SelectItem>
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label='TTL' desc='粘性绑定的存活时长，到期重新选号'>
          <Select
            value={String(sticky.ttl_seconds ?? 86400)}
            onValueChange={(ttlSeconds) =>
              onChange({
                ...sticky,
                ttl_seconds: Number(ttlSeconds),
              })
            }
          >
            <SelectTrigger className='w-40'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[3600, 21600, 86400, 604800, 2592000].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n / 3600} 小时
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
      </CardContent>
    </Card>
  )
}
