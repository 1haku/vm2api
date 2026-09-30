import { queryOptions } from '@tanstack/react-query'
import type {
  ClusterApiNode,
  ClusterLocalStatus,
  DockerContainer,
  DockerInfo,
} from '@/types/panel-cluster'
import { api } from '@/lib/api'

export const CLUSTER_NODES_KEY = ['panel', 'cluster', 'nodes'] as const

export function clusterNodesQueryOptions(refetchInterval = 5000) {
  return queryOptions({
    queryKey: CLUSTER_NODES_KEY,
    queryFn: () =>
      api<{ items: ClusterApiNode[] }>('/api/panel/cluster/nodes').then(
        (d) => d.items
      ),
    refetchInterval,
    refetchOnWindowFocus: false,
  })
}

export const CLUSTER_LOCAL_KEY = ['panel', 'cluster', 'local'] as const

/** 服务端缓存 30s；`refresh` 强制重新观测（两次远端 exec）。 */
export function clusterLocalQueryOptions() {
  return queryOptions({
    queryKey: CLUSTER_LOCAL_KEY,
    queryFn: () => api<ClusterLocalStatus>('/api/panel/cluster/local'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function dockerInfoQueryOptions(nodeId: string, enabled: boolean) {
  return queryOptions({
    queryKey: ['panel', 'cluster', nodeId, 'docker', 'info'] as const,
    queryFn: () =>
      api<DockerInfo>(`/api/panel/cluster/nodes/${nodeId}/docker/info`),
    enabled,
    retry: false,
  })
}

export function dockerContainersQueryOptions(nodeId: string, enabled: boolean) {
  return queryOptions({
    queryKey: ['panel', 'cluster', nodeId, 'docker', 'containers'] as const,
    queryFn: () =>
      api<{ items: DockerContainer[] }>(
        `/api/panel/cluster/nodes/${nodeId}/docker/containers`
      ).then((d) => d.items),
    enabled,
    refetchInterval: enabled ? 5000 : false,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) }
}
