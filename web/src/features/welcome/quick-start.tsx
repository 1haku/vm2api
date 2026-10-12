import { ArrowUpRight } from 'lucide-react'
import { docsHref } from './steps'

const STEPS = [
  {
    n: '1',
    title: '安装',
    body: 'Docker Compose 或一键脚本拉起控制面，打开 /console。',
    href: docsHref('guide/install'),
    label: '安装文档',
  },
  {
    n: '2',
    title: '导入',
    body: '建槽、绑出口、写入订阅账号，打开调度。',
    href: docsHref('guide/console/import'),
    label: '导入文档',
  },
  {
    n: '3',
    title: '调用',
    body: '签发 sk-vm- 密钥，把客户端指到这台网关的 /v1。',
    href: docsHref('guide/api'),
    label: '调用文档',
  },
] as const

export function WelcomeQuickStart() {
  return (
    <section className='mx-auto max-w-6xl px-4 sm:px-6'>
      <h2 className='text-2xl font-semibold tracking-tight'>三步用起来</h2>
      <p className='mt-2 max-w-[42rem] text-sm leading-6 text-muted-foreground'>
        顺序就是生产路径：先有控制面，再有可调度槽，最后才是客户端。
      </p>
      <ol className='mt-6 grid gap-6 sm:grid-cols-3 sm:gap-8'>
        {STEPS.map((step, i) => (
          <li key={step.n} className='relative min-w-0'>
            {i < STEPS.length - 1 ? (
              <span
                aria-hidden='true'
                className='absolute top-4 right-[-1rem] left-[2.25rem] hidden h-px bg-border sm:block'
              />
            ) : null}
            <div className='relative flex size-8 items-center justify-center rounded-full border bg-background font-mono text-sm font-semibold tabular-nums'>
              {step.n}
            </div>
            <h3 className='mt-3 text-base font-semibold'>{step.title}</h3>
            <p className='mt-1.5 text-sm leading-6 text-muted-foreground'>
              {step.body}
            </p>
            <a
              href={step.href}
              target='_blank'
              rel='noreferrer'
              className='mt-3 inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
            >
              {step.label}
              <ArrowUpRight aria-hidden className='size-3.5 opacity-70' />
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}
