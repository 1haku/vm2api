import { Link } from '@tanstack/react-router'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { docsHref } from './steps'

export function WelcomeHero({
  signedIn,
  onLogin,
}: {
  signedIn: boolean
  onLogin: () => void
}) {
  return (
    <section className='relative overflow-hidden'>
      <div
        aria-hidden='true'
        className='pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,color-mix(in_oklch,var(--primary)_22%,transparent),transparent_70%)] motion-reduce:bg-none'
      />
      <div className='relative mx-auto flex max-w-6xl flex-col items-start gap-6 px-4 py-16 sm:px-6 sm:py-24 lg:py-28'>
        <h1 className='max-w-[18ch] text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.25rem] lg:leading-[1.1]'>
          订阅号池，变成标准 API
        </h1>
        <p className='max-w-[42rem] text-base leading-7 text-muted-foreground sm:text-lg'>
          每个槽位跑官方客户端，隔离出口。对外提供 OpenAI / Anthropic
          兼容接口，给 Claude Code、Codex 和现有 SDK 用。
        </p>
        <div className='flex flex-wrap items-center gap-3'>
          {signedIn ? (
            <Button asChild size='lg'>
              <Link to='/overview'>进入控制台</Link>
            </Button>
          ) : (
            <Button size='lg' onClick={onLogin}>
              登录
            </Button>
          )}
          <Button asChild size='lg' variant='outline'>
            <a
              href={docsHref('guide/quick-start')}
              target='_blank'
              rel='noreferrer'
            >
              快速开始文档
              <ArrowUpRight aria-hidden className='size-4' />
            </a>
          </Button>
        </div>
      </div>
    </section>
  )
}
