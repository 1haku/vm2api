export type PanelRole = 'admin' | 'super' | 'user'

export type MeResponse = {
  user: string
  role: PanelRole
  views?: string[]
  capabilities?: string[]
  vm_create_quota?: number
  version?: string
}
