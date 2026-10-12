import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Check } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useOnboardingAction } from './queries'
import {
  docsHref,
  hasPanelView,
  isOnboardingStepId,
  STEP_META,
  type OnboardingStepId,
} from './steps'
import type { OnboardingPayload } from './types'

export function WelcomeChecklist({
  payload,
  views,
}: {
  payload: OnboardingPayload
  views?: string[] | null
}) {
  const action = useOnboardingAction()
  const known = payload.steps.filter(
    (step): step is { id: OnboardingStepId; done: boolean } =>
      isOnboardingStepId(step.id)
  )
  const doneCount = known.filter((step) => step.done).length
  const total = known.length
  const allDone = total > 0 && doneCount >= total
  const percent = total === 0 ? 100 : Math.round((doneCount / total) * 100)

  function run(kind: 'complete' | 'dismiss' | 'reset') {
    action.mutate(kind, {
      onSuccess: () => {
        toast.success(
          kind === 'reset'
            ? '将再次显示引导'
            : kind === 'complete'
              ? '已完成引导'
              : '已跳过引导'
        )
      },
      onError: (error: Error) => toast.error(error.message),
    })
  }

  return (
    <section
      id='welcome-setup'
      className='mx-auto max-w-6xl scroll-mt-20 px-4 sm:px-6'
    >
      <div className='rounded-xl border bg-card px-5 py-6 sm:px-6'>
        <div className='flex flex-wrap items-end justify-between gap-3'>
          <div>
            <h2 className='text-2xl font-semibold tracking-tight'>首配清单</h2>
            <p className='mt-1 text-sm text-muted-foreground'>
              状态来自这台网关当前的真实数据，不是本地勾选。
            </p>
          </div>
          <p className='font-mono text-sm text-muted-foreground tabular-nums'>
            {doneCount}/{total}
          </p>
        </div>
        <Progress
          value={percent}
          className='mt-4'
          aria-label={`引导进度 ${doneCount} / ${total}`}
        />
        <ol className='relative mt-6 space-y-0'>
          {known.map((step, i) => {
            const meta = STEP_META[step.id]
            const showPanel = hasPanelView(views, meta.panelView)
            return (
              <li key={step.id} className='relative flex gap-3 py-3'>
                {i < known.length - 1 ? (
                  <span
                    aria-hidden='true'
                    className={cn(
                      'absolute top-10 bottom-0 left-[11px] w-px',
                      step.done ? 'bg-primary/40' : 'bg-border'
                    )}
                  />
                ) : null}
                <span
                  aria-hidden='true'
                  className={cn(
                    'relative z-10 mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                    step.done
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground'
                  )}
                >
                  {step.done ? (
                    <Check className='size-3.5' strokeWidth={3} />
                  ) : (
                    i + 1
                  )}
                </span>
                <div className='min-w-0 flex-1'>
                  <p className='text-sm font-medium'>
                    {meta.title}
                    <span className='sr-only'>
                      {step.done ? '（已完成）' : '（未完成）'}
                    </span>
                  </p>
                  <p className='mt-0.5 text-sm leading-6 text-muted-foreground'>
                    {meta.description}
                  </p>
                  <div className='mt-2 flex flex-wrap items-center gap-2'>
                    {showPanel ? (
                      <Button asChild size='sm' variant='outline'>
                        <Link to={meta.panelTo}>去面板</Link>
                      </Button>
                    ) : null}
                    <a
                      href={docsHref(meta.docsPath)}
                      target='_blank'
                      rel='noreferrer'
                      className='inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
                    >
                      文档
                      <ArrowUpRight aria-hidden className='size-3.5' />
                    </a>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
        <div className='mt-4 flex flex-wrap items-center gap-2 border-t pt-4'>
          {payload.status !== 'pending' ? (
            <>
              <span className='text-sm text-muted-foreground'>
                {payload.status === 'completed' ? '已完成引导' : '已跳过引导'}
                ，登录后直接进控制台。
              </span>
              <Button
                size='sm'
                variant='ghost'
                disabled={action.isPending}
                onClick={() => run('reset')}
              >
                重新显示引导
              </Button>
            </>
          ) : allDone ? (
            <Button
              size='sm'
              disabled={action.isPending}
              onClick={() => run('complete')}
            >
              完成引导
            </Button>
          ) : (
            <Button
              size='sm'
              variant='outline'
              disabled={action.isPending}
              onClick={() => run('dismiss')}
            >
              跳过引导
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
