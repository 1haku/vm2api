export type ApiKeyItem = {
  id: string
  group_id?: number
  name?: string
  /** 旧字段别名。列表请用 `key_prefix` / `maskApiKeyItem()`。 */
  prefix?: string
  key_prefix?: string
  key_suffix?: string
  /**
   * 列表接口返回掩码（含 `…`）。明文只出现在 create / reveal / rotate 的一次性响应里，
   * 不得渲染到列表、title、toast、console。
   */
  key?: string
  revealable?: boolean
  status?: string
  category?: 'oauth' | 'api'
  max_concurrency?: number
  quota_requests?: number
  quota_used?: number
  quota_usd?: number
  quota_usd_used?: number
  rpm?: number
  expires_at?: string | null
  created_at?: string
  updated_at?: string
  last_used_at?: string
  requests?: number
  inflight?: number
}

export type ApiKeysPayload = {
  keys?: ApiKeyItem[]
}
