import { useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
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

const DEFAULT_URL = 'https://api.anthropic.com'

type AuthScheme = 'x_api_key' | 'authorization_bearer'
type CallMode = 'direct' | 'scheduled'

type ConsoleResult = {
  ok?: boolean
  status?: number
  text?: string
  error?: string
  mode?: CallMode
  auth_scheme?: AuthScheme
  endpoint_name?: string | null
  upstream_model?: string
  proxy?: boolean
  body?: unknown
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
  const [mode, setMode] = useState<CallMode>('direct')
  const [baseUrl, setBaseUrl] = useState(DEFAULT_URL)
  const [apiKey, setApiKey] = useState('')
  const [authScheme, setAuthScheme] = useState<AuthScheme>('x_api_key')
  const [proxyUrl, setProxyUrl] = useState('')
  const [model, setModel] = useState('claude-sonnet-4-5')
  const [maxTokens, setMaxTokens] = useState('256')
  const [message, setMessage] = useState('Hi')
  const [result, setResult] = useState<ConsoleResult | null>(null)

  const send = useMutation({
    mutationFn: () => {
      const max_tokens = Number(maxTokens)
      const body =
        mode === 'scheduled'
          ? { mode, model: model.trim(), max_tokens, message }
          : {
              mode,
              base_url: baseUrl.trim(),
              api_key: apiKey.trim(),
              auth_scheme: authScheme,
              proxy_url: proxyUrl.trim(),
              model: model.trim(),
              max_tokens,
              message,
            }
      return api<ConsoleResult>('/api/panel/anthropic/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    },
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

  return (
    <PageHeader
      title={VIEW_TITLES.anthropic}
      description='直接调用 Anthropic Messages。不走虚拟机。'
    >
      <div className='grid gap-4 lg:grid-cols-[minmax(0,28rem)_minmax(0,1fr)]'>
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
                <Field label='API key'>
                  <Input
                    type='password'
                    autoComplete='off'
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder='sk-ant-…'
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
                <Field label='代理'>
                  <Input
                    value={proxyUrl}
                    onChange={(event) => setProxyUrl(event.target.value)}
                    placeholder='socks5://user:pass@host:port，可空'
                    spellCheck={false}
                  />
                </Field>
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
            <Button disabled={send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? '请求中' : '发送'}
            </Button>
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
              {result ? <span>{result.proxy ? '经代理' : '直连'}</span> : null}
            </div>
            {result?.error ? (
              <p className='text-sm text-destructive'>{result.error}</p>
            ) : null}
            <pre className='max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-sm whitespace-pre-wrap'>
              {result?.text ||
                (result?.body ? JSON.stringify(result.body, null, 2) : '')}
            </pre>
          </CardContent>
        </Card>
      </div>
    </PageHeader>
  )
}
