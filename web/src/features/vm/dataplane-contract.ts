export type KernelDataplane = 'wrap' | 'crag'

export const HOP_TRANSPORT_LABEL = 'Rust · cli-hop'

export const DATAPLANE_HINT =
  '运输固定 Rust cli-hop。wrap 用仓内 patched cli-node（一进程 20 native 槽）；crag 用槽内官方 /home/kincli/.local/bin/claude（一槽一进程，懒启动）。'

export function dataplaneLabel(value: unknown): string {
  return value === 'crag' ? 'crag · 官方 Claude Code' : 'wrap · cli-node'
}
