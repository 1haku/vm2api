import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  ok?: boolean
  status?: number
  text?: string
  error?: string
  proxy?: boolean
}

type ConsoleResult = KeyResult & {
  items?: KeyResult[]
}

type ModelList = {
  models?: { id?: string; name?: string; alias?: string }[]
}

function freshKey(): KeyDraft {
  return { id: crypto.randomUUID(), apiKey: '', proxyId: DIRECT }
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
  const [results, setResults] = useState<Record<string, KeyResult>>({})
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

  function storeResults(data: ConsoleResult, keyIndex: number | null) {
    const incoming = data.items?.length ? data.items : [data]
    setResults((current) => {
      const next = { ...current }
      const targets = keyIndex == null ? keys : [keys[keyIndex]].filter(Boolean)
      targets.forEach((key, index) => {
        if (incoming[index]) next[key.id] = incoming[index]
      })
      return next
    })
  }

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
              keys: keys.map((item) => ({
                api_key: item.apiKey.trim(),
                proxy_id: item.proxyId === DIRECT ? '' : item.proxyId,
              })),
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
    onSuccess: (data, keyIndex) => {
      storeResults(data, keyIndex)
      if (data.ok === false)
        toast.error(data.error || `上游返回 ${data.status || ''}`)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const fetchModels = useMutation({
    mutationFn: () => {
      const key = keys.find((item) => item.apiKey.trim())
      if (!key) throw new Error('先填一把密钥')
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
      const seen: Record<string, true> = {}
      const ids: string[] = []
      for (const item of data.models || []) {
        const id = (item.alias || item.name || item.id || '').trim()
        if (!id || seen[id]) continue
        seen[id] = true
        ids.push(id)
      }
      setModels(ids)
      if (!model && ids[0]) setModel(ids[0])
      if (!ids.length) toast.error('上游没有返回模型')
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <PageHeader title={VIEW_TITLES.anthropic}>
      <div className='mx-auto grid max-w-5xl gap-6'>
        <div className='flex flex-wrap items-end gap-3 border-b pb-4'>
          <Select
            value={mode}
            onValueChange={(value) => setMode(value as CallMode)}
          >
            <SelectTrigger className='w-36' aria-label='调用方式'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='direct'>指定地址</SelectItem>
              <SelectItem value='scheduled'>按地址调度</SelectItem>
            </SelectContent>
          </Select>
          {mode === 'direct' ? (
            <>
              <Input
                className='min-w-64 flex-1'
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                aria-label='地址'
                spellCheck={false}
              />
              <Select
                value={authScheme}
                onValueChange={(value) => setAuthScheme(value as AuthScheme)}
              >
                <SelectTrigger className='w-36' aria-label='认证'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='x_api_key'>x-api-key</SelectItem>
                  <SelectItem value='authorization_bearer'>Bearer</SelectItem>
                </SelectContent>
              </Select>
            </>
          ) : (
            <p className='pb-2 text-sm text-muted-foreground'>
              用已启用的 API 地址轮询，流量走那把 key 的代理。
            </p>
          )}
        </div>

        {mode === 'direct' ? (
          <div>
            <div className='mb-2 grid grid-cols-[minmax(0,1fr)_9rem_4.5rem_3rem] gap-2 px-1 text-xs text-muted-foreground'>
              <span>密钥</span>
              <span>代理</span>
              <span />
              <span />
            </div>
            <div className='divide-y rounded-md border'>
              {keys.map((item, index) => {
                const result = results[item.id]
                return (
                  <div key={item.id} className='px-2 py-2'>
                    <div className='grid grid-cols-[minmax(0,1fr)_9rem_4.5rem_3rem] items-center gap-2'>
                      <Input
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
                            className='justify-start font-normal'
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
                        {testing === index ? '…' : '测试'}
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        disabled={keys.length === 1}
                        onClick={() => {
                          setKeys((current) =>
                            current.filter((key) => key.id !== item.id)
                          )
                          setResults((current) => {
                            const next = { ...current }
                            delete next[item.id]
                            return next
                          })
                        }}
                      >
                        删除
                      </Button>
                    </div>
                    {result ? (
                      <p
                        className={cn(
                          'mt-2 px-1 text-sm whitespace-pre-wrap',
                          result.ok ? 'text-foreground' : 'text-destructive'
                        )}
                      >
                        {result.ok ? '可用' : '不可用'} · HTTP{' '}
                        {result.status || 0}
                        {result.proxy ? ' · 经代理' : ' · 直连'}
                        {result.error || result.text
                          ? `\n${result.error || result.text}`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
            <Button
              type='button'
              variant='ghost'
              className='mt-1 px-2'
              onClick={() => setKeys((current) => [...current, freshKey()])}
            >
              添加一把密钥
            </Button>
          </div>
        ) : null}

        <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem_auto]'>
          {models.length ? (
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className='w-full' aria-label='模型'>
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
              placeholder='模型'
              aria-label='模型'
              spellCheck={false}
            />
          )}
          <Input
            inputMode='numeric'
            value={maxTokens}
            onChange={(event) => setMaxTokens(event.target.value)}
            aria-label='max_tokens'
          />
          {mode === 'direct' ? (
            <Button
              type='button'
              variant='outline'
              disabled={fetchModels.isPending}
              onClick={() => fetchModels.mutate()}
            >
              {fetchModels.isPending ? '获取中' : '获取模型'}
            </Button>
          ) : (
            <span />
          )}
        </div>
        <Textarea
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          aria-label='消息'
        />
        <div>
          <Button
            variant='outline'
            disabled={testing !== null}
            onClick={() => send.mutate(null)}
          >
            {testing === 'all'
              ? '请求中'
              : mode === 'direct'
                ? '全部测试'
                : '发送'}
          </Button>
        </div>
      </div>
    </PageHeader>
  )
}
