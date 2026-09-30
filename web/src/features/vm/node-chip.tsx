import { useQuery } from '@tanstack/react-query'
import { Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { meQueryOptions } from '@/features/auth/queries'
import { clusterNodesQueryOptions } from '@/features/cluster/queries'

/**
 * 槽位所在远端节点。`nodeId` 为空（本机）时不渲染。
 * 节点列表只有 admin / super 可读；其余角色或未加载完时直接显示 node_id。
 * 不挂轮询：列表每行一个实例，靠共享缓存拿标签，避免 N 个定时器。
 */
export function NodeChip({
  nodeId,
  className,
}: {
  nodeId?: string | null
  className?: string
}) {
  const me = useQuery(meQueryOptions())
  const canReadNodes = me.data?.role === 'admin' || me.data?.role === 'super'
  const nodes = useQuery({
    ...clusterNodesQueryOptions(),
    refetchInterval: false,
    enabled: canReadNodes && !!nodeId,
  })
  if (!nodeId) return null
  const node = nodes.data?.find((n) => n.id === nodeId)
  const label = node?.label || node?.host || nodeId
  return (
    <span
      className={cn(
        'inline-flex max-w-[10rem] shrink-0 items-center gap-1 rounded-[5px] border border-border/70 px-1.5 py-0.5 text-[10px] leading-none font-semibold tracking-[0.03em] text-muted-foreground',
        className
      )}
      title={node ? `远端节点 ${label} · ${node.host}` : `远端节点 ${nodeId}`}
    >
      <Server className='size-2.5 shrink-0' aria-hidden='true' />
      <span className='truncate'>{label}</span>
    </span>
  )
}
