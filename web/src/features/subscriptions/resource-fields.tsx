import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Input } from '@/components/ui/input'

export type ResourceConfig = {
  platform: string
  api_endpoints: { endpoint_id: string; priority: number; name?: string }[]
  resource_preference: string
  api_fallback: boolean | number
  resource_models: string[]
}

export const resourceDefaults = {
  api_endpoints: [] as ResourceConfig['api_endpoints'],
  resource_preference: 'slots_first',
  api_fallback: false as boolean | number,
  resource_models: [] as string[],
}

export function ResourceFields<T extends ResourceConfig>({
  value,
  onChange,
}: {
  value: T
  onChange: (value: T) => void
}) {
  const endpoints = useQuery({
    queryKey: ['subscription-api-resources'],
    queryFn: () =>
      api<{
        items: {
          id: string
          name: string
          protocol: string
          disabled: number
        }[]
      }>('/api/panel/subscription-plans/resources'),
  })
  return (
    <fieldset className='space-y-3 rounded-lg border p-3'>
      <legend className='px-1 text-sm'>API 端点（可与槽位共用套餐）</legend>
      <p className='text-xs text-muted-foreground'>
        同一密钥自动选择已绑定资源，日额度、周额度、并发及 RPM
        合并计算。端点优先级数字越大越优先，同级轮询。
      </p>
      {endpoints.isPending && <p className='text-sm'>正在加载端点…</p>}
      {endpoints.error && (
        <p role='alert' className='text-sm text-destructive'>
          无法加载 API 端点，请刷新重试。
        </p>
      )}
      {!endpoints.isPending &&
        !endpoints.error &&
        !endpoints.data?.items.some(
          (e) =>
            e.protocol ===
            (value.platform === 'openai' ? 'openai' : 'anthropic')
        ) && (
          <p className='text-sm text-muted-foreground'>
            暂无对应平台端点，请先在 API 页面添加。
          </p>
        )}
      {endpoints.data?.items
        .filter(
          (e) =>
            e.protocol ===
            (value.platform === 'openai' ? 'openai' : 'anthropic')
        )
        .map((ep) => {
          const bound = value.api_endpoints.find((e) => e.endpoint_id === ep.id)
          return (
            <div key={ep.id} className='flex items-center gap-3'>
              <label className='flex flex-1 items-center gap-2 text-sm'>
                <input
                  type='checkbox'
                  checked={!!bound}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      api_endpoints: e.target.checked
                        ? [
                            ...value.api_endpoints,
                            { endpoint_id: ep.id, priority: 0 },
                          ]
                        : value.api_endpoints.filter(
                            (b) => b.endpoint_id !== ep.id
                          ),
                    })
                  }
                />
                {ep.name}
                {ep.disabled ? '（已停用）' : ''}
              </label>
              {bound && (
                <Input
                  aria-label={`${ep.name} 优先级`}
                  className='w-24'
                  type='number'
                  min={-10000}
                  max={10000}
                  step={1}
                  value={bound.priority}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      api_endpoints: value.api_endpoints.map((b) =>
                        b.endpoint_id === ep.id
                          ? { ...b, priority: Number(e.target.value) }
                          : b
                      ),
                    })
                  }
                />
              )}
            </div>
          )
        })}
      <label className='grid gap-2 text-sm'>
        资源优先顺序
        <select
          className='h-10 rounded-md border bg-background px-3'
          value={value.resource_preference}
          onChange={(e) =>
            onChange({ ...value, resource_preference: e.target.value })
          }
        >
          <option value='slots_first'>槽位优先</option>
          <option value='api_first'>API 优先</option>
        </select>
      </label>
      <label className='flex items-center gap-2 text-sm'>
        <input
          type='checkbox'
          checked={!!value.api_fallback}
          onChange={(e) =>
            onChange({ ...value, api_fallback: e.target.checked })
          }
        />
        槽位不可用时允许切换 API
      </label>
      <p className='text-xs text-muted-foreground'>
        切换可能产生 API
        费用。仅在尚未开始响应、未产生用量且遇到容量或上游故障时重试；权限、内容审查及额度限制不会触发切换。
      </p>
      <label className='grid gap-2 text-sm'>
        允许的模型（可选，每行一个公开模型 ID）
        <textarea
          className='min-h-20 rounded-md border bg-background p-2'
          value={value.resource_models.join('\n')}
          onChange={(e) =>
            onChange({ ...value, resource_models: e.target.value.split('\n') })
          }
          onBlur={() =>
            onChange({
              ...value,
              resource_models: value.resource_models
                .map((m) => m.trim())
                .filter(Boolean),
            })
          }
          placeholder='留空允许已绑定资源支持的全部模型'
        />
      </label>
    </fieldset>
  )
}
