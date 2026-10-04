import { useQuery } from '@tanstack/react-query'
import type { RequestLogItem } from '@/types/panel-logs'
import { maskPresentedKey } from '@/lib/log-mute'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { requestLogQueryOptions } from '../queries'

const SECRET_KEY =
  /access_token|refresh_token|session_key|password|secret|authorization|cookie|master_key|api_key|proxy_url|oauth/i

/** debug 记录里值得单独展开的结构化块（已在后端脱敏）。 */
const BLOCKS: [string, string][] = [
  ['headers', '入站请求头'],
  ['inbound_summary', '入站摘要'],
  ['request_body_snapshot', '请求体快照'],
  ['inbound_body', '入站请求体'],
  ['hop_meta', '链路元数据'],
  ['outbound_summary', '出站摘要'],
  ['outbound_headers', '出站请求头'],
  ['outbound_body', '出站请求体'],
  ['cache_prefix', '缓存前缀'],
  ['cache_continuity', '缓存连续性'],
  ['classifier', '分类器'],
]

function pretty(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * 调试采样记录（`/api/panel/request-logs/:id`）。只有 debug 模式落库的请求才有
 * 完整的头/体快照；普通请求回落到摘要行，这里只露出上游状态与入站 Key。
 */
export function DebugRecordSection({ requestId }: { requestId: string }) {
  const detail = useQuery(requestLogQueryOptions(requestId))
  const item = detail.data?.item as RequestLogItem | undefined
  if (detail.isLoading) {
    return <p className='text-xs text-muted-foreground'>加载调试记录…</p>
  }
  if (detail.error || !item) return null

  const upstream =
    item.upstream_status != null && item.upstream_status !== ''
      ? String(item.upstream_status)
      : null
  const blocks = BLOCKS.filter(
    ([key]) => item[key] != null && item[key] !== '' && !SECRET_KEY.test(key)
  )
  if (!upstream && !item.api_key_presented && !blocks.length) return null

  return (
    <div className='space-y-2'>
      <h4 className='text-sm font-semibold text-muted-foreground'>调试记录</h4>
      <div className='space-y-3 rounded-lg border bg-card p-4 text-sm'>
        {upstream ? (
          <div className='flex justify-between'>
            <span className='text-muted-foreground'>上游状态:</span>
            <Badge variant='outline' className='font-mono'>
              {upstream}
            </Badge>
          </div>
        ) : null}
        {item.api_key_presented ? (
          // 入站 Key 是攻击者可控的明文：只渲染掩码，不设 title、不提供复制。
          <div className='flex justify-between gap-3'>
            <span className='text-muted-foreground'>入站 Key:</span>
            <span className='font-mono text-xs'>
              {maskPresentedKey(item.api_key_presented)}
            </span>
          </div>
        ) : null}
        {blocks.map(([key, label]) => (
          <Collapsible key={key}>
            <CollapsibleTrigger className='text-xs text-muted-foreground hover:text-foreground'>
              {label} ▸
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className='mt-2 max-h-[320px] overflow-auto rounded-md bg-muted/50 p-3 font-mono text-[11px] break-words whitespace-pre-wrap'>
                {pretty(item[key])}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ))}
      </div>
    </div>
  )
}
