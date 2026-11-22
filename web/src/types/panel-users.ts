import type { PanelRole } from './panel-auth'

export type PanelUser = {
  id: string
  username: string
  role: PanelRole
  enabled: boolean
  vm_create_quota?: number
  concurrency?: number
  rpm_limit?: number
  image_generation_enabled?: boolean
  /** 该账号是否已开启两步验证（只读，管理员可重置）。 */
  two_factor?: boolean
  created_at?: string
  last_login_at?: string
}

export type PanelUsersPayload = {
  items?: PanelUser[]
}
