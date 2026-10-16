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
  label: string
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
  auth_scheme?: AuthScheme
  endpoint_name?: string | null
  upstream_model?: string
  body?: unknown
  items?: KeyResult[]
}

function freshKey(): KeyDraft {
  return {
    id: crypto.randomUUID(),
    label: '',
    apiKey: '',
    proxyId: DIRECT,
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='grid gap-1.5'>
      <Label>{label}</Label>
      {children}
    </div>
  )
}

export function AnthropicConsolePage() {
  const proxies = useQuery(proxiesQueryOptions())
  const options = (proxies.data?.proxies || []).filter((item) => item.id)
  const [mode, setMode] = useState<CallMode>('direct')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_URL)
  const [authScheme, setAuthScheme] = useState<AuthScheme>('x_api_key')
  const [keys, setKeys] = useState<KeyDraft[]>([freshKey()])
  const [model, setModel] = useState('claude-sonnet-4-5')
  const [maxTokens, setMaxTokens] = useState('256')
  const [message, setMessage] = useState('Hi')
  const [testing, setTesting] = useState<number | 'all' | null>(null)
  const [result, setResult] = useState<ConsoleResult | null>(null)

  function patchKey(id: string, patch: Partial<KeyDraft>) {
    setKeys((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    )
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
                label: item.label.trim(),
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
    onSuccess: (data) => {
      setResult(data)
      if (data.ok === false)
        toast.error(data.error || `上游返回 ${data.status || ''}`)
    },
    onError: (error: Error) => {
      setResult(null)
      toast.error(error.message)
    },
  })

  const rows = result?.items?.length ? result.items : result ? [result] : []

  return (
    <PageHeader
      title={VIEW_TITLES.anthropic}
      description='直接调用 Anthropic Messages。不走虚拟机。'
    >
      <div className='grid gap-4 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)]'>
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
                        Authorization: Bearer
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className='grid gap-2'>
                  <div className='flex items-center justify-between gap-2'>
                    <Label>API key</Label>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      onClick={() =>
                        setKeys((current) => [...current, freshKey()])
                      }
                    >
                      添加 key
                    </Button>
                  </div>
                  {keys.map((item, index) => (
                    <div
                      key={item.id}
                      className='grid gap-2 rounded-md border p-3'
                    >
                      <div className='grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)]'>
                        <Input
                          value={item.label}
                          onChange={(event) =>
                            patchKey(item.id, { label: event.target.value })
                          }
                          placeholder={`key ${index + 1}`}
                        />
                        <Input
                          type='password'
                          autoComplete='off'
                          value={item.apiKey}
                          onChange={(event) =>
                            patchKey(item.id, { apiKey: event.target.value })
                          }
                          placeholder='sk-ant-…'
                        />
                      </div>
                      <div className='flex items-center gap-2'>
                        <Select
                          value={item.proxyId}
                          onValueChange={(value) =>
                            patchKey(item.id, { proxyId: value })
                          }
                        >
                          <SelectTrigger className='w-full'>
                            <SelectValue placeholder='选择代理' />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={DIRECT}>直连</SelectItem>
                            {options.map((proxy) => (
                              <SelectItem key={proxy.id} value={proxy.id || ''}>
                                {proxyLabel(proxy)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          disabled={testing !== null}
                          onClick={() => send.mutate(index)}
                        >
                          {testing === index ? '测试中' : '测试'}
                        </Button>
                        <Button
                          type='button'
                          size='sm'
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
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className='text-sm text-muted-foreground'>
                用 API 页里已启用的地址、模型和
                key。前缀、优先级和轮询沿用那里的调度，流量走对应 key 的代理。
              </p>
            )}
            <div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem]'>
              <Field label='模型'>
                <Input
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder={
                    mode === 'scheduled'
                      ? '别名或 prefix/别名'
                      : 'claude-sonnet-4-5'
                  }
                  spellCheck={false}
                />
              </Field>
              <Field label='max_tokens'>
                <Input
                  inputMode='numeric'
                  value={maxTokens}
                  onChange={(event) => setMaxTokens(event.target.value)}
                />
              </Field>
            </div>
            <Field label='消息'>
              <Textarea
                rows={5}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
              />
            </Field>
            <div className='flex gap-2'>
              <Button
                className='flex-1'
                disabled={testing !== null}
                onClick={() => send.mutate(null)}
              >
                {testing === 'all'
                  ? '请求中'
                  : mode === 'direct'
                    ? '批量验证'
                    : '发送'}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className='min-w-0'>
          <CardContent className='grid gap-3 pt-6'>
            <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground'>
              <span className={cn(result?.ok ? 'text-foreground' : '')}>
                {result ? `HTTP ${result.status || 0}` : '还没有响应'}
              </span>
              {result?.endpoint_name ? (
                <span>{result.endpoint_name}</span>
              ) : null}
              {result?.upstream_model ? (
                <span>{result.upstream_model}</span>
              ) : null}
            </div>
            {result?.error ? (
              <p className='text-sm text-destructive'>{result.error}</p>
            ) : null}
            {rows.length ? (
              <div className='grid gap-2'>
                {rows.map((item, index) => (
                  <div
                    key={`${item.label || 'result'}-${index}`}
                    className='rounded-md border p-3'
                  >
                    <div className='mb-2 flex flex-wrap gap-x-3 text-sm'>
                      <span>{item.label || `key ${index + 1}`}</span>
                      <span
                        className={
                          item.ok ? 'text-foreground' : 'text-destructive'
                        }
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
              </div>
            ) : (
              <pre className='max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap' />
            )}
          </CardContent>
        </Card>
      </div>
    </PageHeader>
  )
}
