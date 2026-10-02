import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Copy, KeyRound, ArrowRight, BookOpen } from 'lucide-react'
import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { apiBase } from '@/lib/session'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import type { Subscription } from './index'

const usd = (n: number) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6,
  }).format(n)
async function copy(value: string) {
  try {
    await copyText(value)
    toast.success('已复制')
  } catch {
    toast.error('浏览器不允许复制，请选中文本手动复制')
  }
}
export function SubscriptionHome({
  items,
  loading,
  error,
  onCreate,
  pending,
}: {
  items: Subscription[]
  loading: boolean
  error: Error | null
  onCreate: (s: Subscription) => void
  pending: boolean
}) {
  const [selected, setSelected] = useState('')
  const active = items.filter(
    (s) => s.status === 'active' && s.plan_status === 'active'
  )
  const current = items.find((s) => s.id === selected) || active[0] || items[0]
  const base = (apiBase() || window.location.origin).replace(/\/$/, '')
  const openai = current?.platform === 'openai'
  const url = openai ? `${base}/v1` : base
  const example = openai
    ? `curl '${base}/v1/responses' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"YOUR_MODEL","input":"Hello","stream":true}'`
    : `curl '${base}/v1/messages' \\\n  -H 'x-api-key: YOUR_API_KEY' \\\n  -H 'anthropic-version: 2023-06-01' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"YOUR_MODEL","max_tokens":256,"messages":[{"role":"user","content":"Hello"}]}'`
  return (
    <div className='space-y-6'>
      <section className='rounded-xl border border-primary/25 bg-primary/5 p-5 sm:p-6'>
        <div className='flex flex-wrap items-start justify-between gap-4'>
          <div>
            <p className='text-sm font-medium text-primary'>个人工作台</p>
            <h2 className='mt-2 text-2xl font-semibold'>
              {active.length
                ? `你有 ${active.length} 个生效中的订阅`
                : '从你的第一个订阅开始'}
            </h2>
            <p className='mt-2 text-sm text-muted-foreground'>
              查看额度，创建个人密钥，再将接入地址填入客户端。
            </p>
          </div>
          <Button asChild variant='outline'>
            <Link to='/usage-records'>
              查看我的使用明细
              <ArrowRight className='size-4' />
            </Link>
          </Button>
        </div>
        <ol className='mt-6 grid gap-3 sm:grid-cols-3'>
          {[
            '1. 确认订阅与账号状态',
            '2. 创建并保存个人密钥',
            '3. 复制地址，配置客户端',
          ].map((s) => (
            <li
              key={s}
              className='rounded-lg border bg-background/70 p-3 text-sm'
            >
              {s}
            </li>
          ))}
        </ol>
      </section>
      {error && (
        <p role='alert' className='text-destructive'>
          {error.message}
        </p>
      )}
      {loading && <p>正在加载你的订阅…</p>}
      {!loading && !items.length && !error && (
        <div className='rounded-xl border border-dashed p-8 text-center'>
          <h3 className='font-semibold'>还没有分配订阅</h3>
          <p className='mt-2 text-sm text-muted-foreground'>
            请联系管理员，在“用户管理 → 分配订阅”中为你的账号选择方案。
          </p>
        </div>
      )}
      <div className='grid gap-4 xl:grid-cols-2'>
        {items.map((s) => {
          const usable = s.status === 'active' && s.plan_status === 'active'
          const leftDays = Math.max(
            0,
            Math.ceil((Date.parse(s.expires_at) - Date.now()) / 86400000)
          )
          return (
            <section key={s.id} className='rounded-xl border bg-card p-5'>
              <div className='flex flex-wrap items-center justify-between gap-2'>
                <h3 className='text-lg font-semibold'>{s.plan_name}</h3>
                <Badge variant={usable ? 'secondary' : 'outline'}>
                  {s.platform === 'openai'
                    ? 'OpenAI / Codex'
                    : 'Anthropic / Claude'}
                </Badge>
              </div>
              <p
                className={`mt-3 rounded-lg p-3 text-sm ${s.availability?.code === 'configured' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}
              >
                {s.availability?.message || '正在读取订阅状态'}
              </p>
              <div className='my-5 space-y-4'>
                {[
                  ['今日', s.daily_used, s.daily_limit_usd, s.daily_reset_at],
                  [
                    '本周',
                    s.weekly_used,
                    s.weekly_limit_usd,
                    s.weekly_reset_at,
                  ],
                ].map(([label, used, limit, reset]) => (
                  <div key={String(label)}>
                    <div className='flex flex-wrap items-baseline justify-between gap-2 text-sm'>
                      <span>
                        {label}剩余{' '}
                        <strong>
                          {Number(limit) > 0
                            ? usd(
                                Math.max(
                                  0,
                                  Number(limit) -
                                    Number(used) -
                                    (s.pending_cost || 0)
                                )
                              )
                            : '不限'}
                        </strong>
                      </span>
                      <span className='text-xs text-muted-foreground'>
                        已用 {usd(Number(used))}
                        {Number(limit) > 0 ? ` / ${usd(Number(limit))}` : ''}
                      </span>
                    </div>
                    <Progress
                      className='mt-2 h-2'
                      value={
                        Number(limit) > 0
                          ? Math.min(100, (Number(used) / Number(limit)) * 100)
                          : 0
                      }
                    />
                    <p className='mt-1 text-xs text-muted-foreground'>
                      {new Date(String(reset)).toLocaleString('zh-CN')} 重置
                    </p>
                  </div>
                ))}
              </div>
              {!!s.pending_cost && (
                <p className='mb-3 text-xs text-muted-foreground'>
                  进行中请求已预留 {usd(s.pending_cost)}，结束后按实际用量结算。
                </p>
              )}
              <div className='flex flex-wrap items-center justify-between gap-3 border-t pt-4'>
                <p className='text-xs text-muted-foreground'>
                  到期：{new Date(s.expires_at).toLocaleString('zh-CN')}
                  <span className='block'>
                    剩余 {leftDays} 天 · 个人额度与上游账号额度分别计算
                  </span>
                </p>
                <div className='flex gap-2'>
                  <Button
                    variant='outline'
                    size='sm'
                    onClick={() => {
                      setSelected(s.id)
                      document
                        .getElementById('connection-guide')
                        ?.scrollIntoView({ behavior: 'smooth' })
                    }}
                  >
                    接入指引
                  </Button>
                  <Button
                    size='sm'
                    disabled={!usable || pending}
                    onClick={() => {
                      setSelected(s.id)
                      onCreate(s)
                    }}
                  >
                    <KeyRound className='size-4' />
                    创建密钥
                  </Button>
                </div>
              </div>
            </section>
          )
        })}
      </div>
      {!!items.length && (
        <section
          id='connection-guide'
          className='scroll-mt-24 rounded-xl border bg-card p-5 sm:p-6'
        >
          <h2 className='flex items-center gap-2 text-lg font-semibold'>
            <BookOpen className='size-5' />
            客户端接入指引
          </h2>
          <p className='mt-2 text-sm text-muted-foreground'>
            每个方案使用对应的个人密钥；登录面板的密码不能作为 API Key 使用。
          </p>
          <label className='mt-4 grid gap-2 text-sm'>
            配置哪个订阅
            <select
              className='h-10 rounded-md border bg-background px-3'
              value={current?.id || ''}
              onChange={(e) => setSelected(e.target.value)}
            >
              {items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.plan_name}
                </option>
              ))}
            </select>
          </label>
          <div className='mt-5 grid gap-4 lg:grid-cols-2'>
            <div className='space-y-4'>
              <div>
                <p className='mb-2 text-sm font-medium'>客户端类型</p>
                <p className='text-sm text-muted-foreground'>
                  {openai
                    ? '支持 OpenAI Responses 的客户端（或启用 Chat Completions 转换的客户端）'
                    : '支持 Anthropic Messages 的客户端'}
                </p>
              </div>
              <div>
                <p className='mb-2 text-sm font-medium'>Base URL</p>
                <div className='flex items-start gap-2 rounded-lg bg-muted p-3'>
                  <code className='min-w-0 flex-1 text-sm break-all'>
                    {url}
                  </code>
                  <Button
                    size='sm'
                    variant='ghost'
                    aria-label='复制 API 地址'
                    onClick={() => void copy(url)}
                  >
                    <Copy className='size-4' />
                  </Button>
                </div>
                <p className='mt-2 text-xs text-muted-foreground'>
                  {openai
                    ? '上方地址已包含 /v1，不要重复添加。'
                    : 'Anthropic Base URL 使用根地址，请求路径为 /v1/messages。'}
                </p>
              </div>
              <p className='text-sm'>
                API Key：使用上方“创建密钥”生成的密钥，也可在
                <Link to='/keys' className='text-primary underline'>
                  我的密钥
                </Link>
                中管理。
              </p>
              <p className='text-xs text-muted-foreground'>
                模型：携带个人密钥请求 <code>{base}/v1/models</code>{' '}
                获取模型列表，选择与订阅平台相符的模型。示例中的 YOUR_MODEL 和
                YOUR_API_KEY 需要替换。
              </p>
            </div>
            <div className='min-w-0'>
              <div className='mb-2 flex items-center justify-between'>
                <p className='text-sm font-medium'>curl 示例（Bash）</p>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => void copy(example)}
                >
                  复制示例
                </Button>
              </div>
              <pre className='overflow-x-auto rounded-lg bg-muted p-4 text-xs leading-6'>
                {example}
              </pre>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
