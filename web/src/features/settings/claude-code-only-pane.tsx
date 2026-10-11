import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type Compat = Record<string, unknown>

export function ClaudeCodeOnlyPane({
  compat,
  onChange,
}: {
  compat: Compat
  onChange: (next: Compat) => void
}) {
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>客户端准入</CardTitle>
      </CardHeader>
      <CardContent>
        <SettingRow
          label='仅允许 Claude Code 家族请求'
          desc='开启后 Claude 模型只接受官方 Claude Code（claude-cli UA + 官方 system / user_id），第三方客户端和 OpenAI 格式入口调 Claude 一律 403 claude_code_only。被中转的官方流量跟随「识别中转来的官方 Claude Code」。GPT 模型不受影响。'
        >
          <Switch
            checked={compat.claude_code_only === true}
            onCheckedChange={(on) =>
              onChange({ ...compat, claude_code_only: on })
            }
            aria-label='仅允许 Claude Code 家族请求'
          />
        </SettingRow>
      </CardContent>
    </Card>
  )
}
