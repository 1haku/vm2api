import { useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PageHeader } from '@/components/page-header'
import { proxyLabel } from '@/features/proxies/proxy-sort'
import { proxiesQueryOptions } from '@/features/proxies/queries'

const DEFAULT_URL = 'https://api.anthropic.com'
const DIRECT = '__direct__'

type AuthScheme = 'x_api_key' | 'authorization_bearer'
type CallMode = 'direct' | 'scheduled'

type KeyDraft = {
  id: string
  apiKey: string
  proxyId: string
}

type KeyResult = {
  label?: string
  ok?: boolean
  status?: number
  text?: string
  error?: string
  proxy?: boolean
}

type ConsoleResult = KeyResult & {
  mode?: CallMode
  endpoint_name?: string | null
  upstream_model?: string
  items?: KeyResult[]
}

type ModelList = {
  models?: { id?: string; name?: string; alias?: string }[]
}

function freshKey(): KeyDraft {
  return { id: crypto.randomUUID(), apiKey: '', proxyId: DIRECT }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='grid gap-1.5'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

function maskKey(value: string) {
  const text = value.trim()
  if (text.length <= 8) return text ? '••••' : '空 key'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

export function AnthropicConsolePage() {
  const proxies = useQuery(proxiesQueryOptions())
  const options = (proxies.data?.proxies || []).filter((item) => item.id)
  const [mode, setMode] = useState<CallMode>('direct')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_URL)
  const [authScheme, setAuthScheme] = useState<AuthScheme>('x_api_key')
  const [keys, setKeys] = useState<KeyDraft[]>([freshKey()])
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [maxTokens, setMaxTokens] = useState('256')
  const [message, setMessage] = useState('Hi')
  const [testing, setTesting] = useState<number | 'all' | null>(null)
  const [result, setResult] = useState<ConsoleResult | null>(null)
  const [openProxy, setOpenProxy] = useState<string | null>(null)

  function patchKey(id: string, patch: Partial<KeyDraft>) {
    setKeys((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    )
  }

  function proxyName(id: string) {
    if (id === DIRECT) return '直连'
    const found = options.find((item) => item.id === id)
    return found ? proxyLabel(found) : '代理不可用'
  }

  const payloadKeys = () =>
    keys.map((item) => ({
      api_key: item.apiKey.trim(),
      proxy_id: item.proxyId === DIRECT ? '' : item.proxyId,
    }))

  const send = useMutation({
    mutationFn: (keyIndex: number | null) => {
      const max_tokens = Number(maxTokens)
      const body =
        mode === 'scheduled'
          ? { mode, model: model.trim(), max_tokens, message }
          : {
              mode,
              base_url: baseUrl.trim(),
              auth_scheme: authScheme,
              model: model.trim(),
              max_tokens,
              message,
              keys: payloadKeys(),
              ...(keyIndex == null ? {} : { key_index: keyIndex }),
            }
      return api<ConsoleResult>('/api/panel/anthropic/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
    onMutate: (keyIndex) => setTesting(keyIndex == null ? 'all' : keyIndex),
    onSettled: () => setTesting(null),
    onSuccess: (data) => {
      setResult(data)
      if (data.ok === false)
        toast.error(data.error || `上游返回 ${data.status || ''}`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const fetchModels = useMutation({
    mutationFn: () => {
      const key = keys.find((item) => item.apiKey.trim())
      if (!key) throw new Error('先填一把 API key')
      return api<ModelList>('/api/panel/api-endpoints/fetch-models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'custom',
          protocol: 'anthropic',
          base_url: baseUrl.trim() || DEFAULT_URL,
          api_key: key.apiKey.trim(),
          auth_scheme: authScheme,
          proxy_id: key.proxyId === DIRECT ? '' : key.proxyId,
        }),
      })
    },
    onSuccess: (data) => {
      const ids = (data.models || [])
        .map((item) => item.alias || item.name || item.id || '')
        .map((item) => item.trim())
        .filter(Boolean)
      setModels([...new Set(ids)])
      if (!model && ids[0]) setModel(ids[0])
      if (!ids.length) toast.error('上游没有返回模型')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const rows = result?.items?.length ? result.items : result ? [result] : []

  return (
    <PageHeader
      title={VIEW_TITLES.anthropic}
      description='直接调用 Anthropic Messages。不走虚拟机。'
    >
      <div className='grid gap-4 xl:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]'>
        <Card>
          <CardContent className='grid gap-3 pt-6'>
            <Field label='方式'>
              <Select
                value={mode}
                onValueChange={(value) => setMode(value as CallMode)}
              >
                <SelectTrigger className='w-full'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='direct'>指定地址</SelectItem>
                  <SelectItem value='scheduled'>按 API 地址调度</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {mode === 'direct' ? (
              <>
                <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]'>
                  <Field label='地址'>
                    <Input
                      value={baseUrl}
                      onChange={(event) => setBaseUrl(event.target.value)}
                      placeholder={DEFAULT_URL}
                      spellCheck={false}
                    />
                  </Field>
                  <Field label='认证'>
                    <Select
                      value={authScheme}
                      onValueChange={(value) =>
                        setAuthScheme(value as AuthScheme)
                      }
                    >
                      <SelectTrigger className='w-full'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='x_api_key'>x-api-key</SelectItem>
                        <SelectItem value='authorization_bearer'>
                          Bearer
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <div className='grid gap-2'>
                  <div className='flex items-center justify-between'>
                    <Label>密钥</Label>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      onClick={() =>
                        setKeys((current) => [...current, freshKey()])
                      }
                    >
                      添加
                    </Button>
                  </div>
                  {keys.map((item, index) => (
                    <div key={item.id} className='flex items-center gap-2'>
                      <Input
                        className='min-w-0 flex-1'
                        type='password'
                        autoComplete='off'
                        value={item.apiKey}
                        onChange={(event) =>
                          patchKey(item.id, { apiKey: event.target.value })
                        }
                        placeholder='sk-ant-…'
                        aria-label={`密钥 ${index + 1}`}
                      />
                      <Popover
                        open={openProxy === item.id}
                        onOpenChange={(open) =>
                          setOpenProxy(open ? item.id : null)
                        }
                      >
                        <PopoverTrigger asChild>
                          <Button
                            type='button'
                            variant='outline'
                            className='w-36 justify-start'
                          >
                            <span className='truncate'>
                              {proxyName(item.proxyId)}
                            </span>
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          align='end'
                          className='grid max-h-72 gap-1 overflow-auto p-2'
                        >
                          <Button
                            type='button'
                            variant={
                              item.proxyId === DIRECT ? 'secondary' : 'ghost'
                            }
                            className='justify-start'
                            onClick={() => {
                              patchKey(item.id, { proxyId: DIRECT })
                              setOpenProxy(null)
                            }}
                          >
                            直连
                          </Button>
                          {options.map((proxy) => (
                            <Button
                              key={proxy.id}
                              type='button'
                              variant={
                                item.proxyId === proxy.id
                                  ? 'secondary'
                                  : 'ghost'
                              }
                              className='justify-start'
                              onClick={() => {
                                patchKey(item.id, {
                                  proxyId: proxy.id || DIRECT,
                                })
                                setOpenProxy(null)
                              }}
                            >
                              <span className='truncate'>
                                {proxyLabel(proxy)}
                              </span>
                            </Button>
                          ))}
                        </PopoverContent>
                      </Popover>
                      <Button
                        type='button'
                        variant='outline'
                        disabled={testing !== null}
                        onClick={() => send.mutate(index)}
                      >
                        {testing === index ? '测试中' : '测试'}
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        disabled={keys.length === 1}
                        onClick={() =>
                          setKeys((current) =>
                            current.filter((key) => key.id !== item.id)
                          )
                        }
                      >
                        删除
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className='text-sm text-muted-foreground'>
                用 API 页里已启用的地址、模型和 key。流量走对应 key 的代理。
              </p>
            )}
            <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto]'>
              <Field label='模型'>
                {models.length ? (
                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger className='w-full'>
                      <SelectValue placeholder='选择模型' />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    placeholder='先获取模型，或手填'
                    spellCheck={false}
                  />
                )}
              </Field>
              <Field label='max_tokens'>
                <Input
                  inputMode='numeric'
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(event.target.value)}
                />
              </Field>
              {mode === 'direct' ? (
                <Button
                  type='button'
                  variant='outline'
                  className='self-end'
                  disabled={fetchModels.isPending}
                  onClick={() => fetchModels.mutate()}
                >
                  {fetchModels.isPending ? '获取中' : '获取模型'}
                </Button>
              ) : null}
            </div>
            <Field label='消息'>
              <Textarea
                rows={4}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </Field>
            <Button
              disabled={testing !== null}
              onClick={() => send.mutate(null)}
            >
              {testing === 'all'
                ? '请求中'
                : mode === 'direct'
                  ? '批量验证'
                  : '发送'}
            </Button>
          </CardContent>
        </Card>

        <Card className='min-w-0'>
          <CardContent className='grid gap-3 pt-6'>
            <div className='text-sm text-muted-foreground'>
              {result ? `HTTP ${result.status || 0}` : '还没有响应'}
              {result?.upstream_model ? ` · ${result.upstream_model}` : ''}
            </div>
            {result?.error ? (
              <p className='text-sm text-destructive'>{result.error}</p>
            ) : null}
            {rows.map((item, index) => (
              <div
                key={`${item.label || index}`}
                className='rounded-md border p-3'
              >
                <div className='mb-2 flex flex-wrap gap-x-3 text-sm'>
                  <span>
                    {item.label || maskKey(keys[index]?.apiKey || '')}
                  </span>
                  <span
                    className={cn(
                      item.ok ? 'text-foreground' : 'text-destructive'
                    )}
                  >
                    {item.ok ? '可用' : '不可用'} · HTTP {item.status || 0}
                  </span>
                  <span className='text-muted-foreground'>
                    {item.proxy ? '经代理' : '直连'}
                  </span>
                </div>
                <pre className='max-h-48 overflow-auto text-sm whitespace-pre-wrap'>
                  {item.error || item.text || ''}
                </pre>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </PageHeader>
  )
}
