import type { VmKernelSnapshot } from '@/types/panel-vm'

export function telemetryStatusLabel(telemetry: VmKernelSnapshot['telemetry']) {
  if (telemetry?.enabled === false) return '未启用'
  if (telemetry?.enabled !== true) return '状态未知'
  if (telemetry.running === true) return '运行中'
  if (telemetry.running === false) return '已开启 · 进程未运行'
  return '已开启 · 运行状态未知'
}
