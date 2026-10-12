import { ArrowUpRight } from 'lucide-react'
import { CopyButton, CopyChip } from '@/components/copy-chip'
import { docsHref } from './steps'

function snippets(base: string) {
  const claude = [
    `export ANTHROPIC_BASE_URL=${base}`,
    'export ANTHROPIC_AUTH_TOKEN=sk-vm-xxxx',
  ].join('\n')
  const codex = [
    'model = "gpt-5.4"',
    'model_provider = "vm2api"',
    '',
    '[model_providers.vm2api]',
    'name = "vm2api"',
    `base_url = "${base}/v1"`,
    'env_key = "VM2API_KEY"',
    'wire_api = "responses"',
  ].join('\n')
  const curl = [
    `curl -sS ${base}/v1/messages \\`,
    '  -H "Authorization: Bearer sk-vm-xxxx" \\',
    '  -H "content-type: application/json" \\',
    "  -d '{",
    '    "model": "claude-sonnet-5",',
    '    "max_tokens": 128000,',
    '    "messages": [{"role": "user", "content": "hello"}]',
    "  }'",
  ].join('\n')
  return { claude, codex, curl }
}

function Snippet({
  title,
  hint,
  code,
}: {
  title: string
  hint: string
  code: string
}) {
  return (
    <div className='min-w-0 rounded-lg border bg-background'>
      <div className='flex items-start justify-between gap-3 px-3 py-2'>
        <div className='min-w-0'>
          <h3 className='text-sm font-medium'>{title}</h3>
          <p className='text-xs text-muted-foreground'>{hint}</p>
        </div>
        <CopyButton text={code} label={`复制 ${title}`} />
      </div>
      <pre className='overflow-x-auto border-t px-3 py-3 font-mono text-[12px] leading-5'>
        {code}
      </pre>
    </div>
  )
}

export function WelcomeClientSnippets({ baseUrl }: { baseUrl: string }) {
  const base = baseUrl.replace(/\/$/, '') || location.origin
  const { claude, codex, curl } = snippets(base)
  return (
    <section className='mx-auto max-w-6xl px-4 sm:px-6'>
      <div className='flex flex-wrap items-end justify-between gap-3'>
        <div>
          <h2 className='text-2xl font-semibold tracking-tight'>客户端接入</h2>
          <p className='mt-2 max-w-[42rem] text-sm leading-6 text-muted-foreground'>
            密钥用占位符 sk-vm-xxxx，到控制台签发真实的。Master
            密钥不要写进客户端。
          </p>
        </div>
        <CopyChip text={`${base}/v1`} />
      </div>
      <div className='mt-6 grid gap-4 lg:grid-cols-2'>
        <Snippet
          title='Claude Code'
          hint='ANTHROPIC_BASE_URL 是主机，不要带 /v1'
          code={claude}
        />
        <Snippet
          title='Codex · ~/.codex/config.toml'
          hint='env_key 是 VM2API_KEY，不是 Master 的 VM2API_API_KEY'
          code={codex}
        />
        <div className='lg:col-span-2'>
          <Snippet
            title='curl · POST /v1/messages'
            hint='鉴权过了才会看到 content'
            code={curl}
          />
        </div>
      </div>
      <a
        href={docsHref('guide/clients')}
        target='_blank'
        rel='noreferrer'
        className='mt-4 inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
      >
        完整接入说明
        <ArrowUpRight aria-hidden className='size-3.5 opacity-70' />
      </a>
    </section>
  )
}
