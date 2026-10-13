import { Link } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useOnboardingAction } from './queries'
import type { OnboardingPayload } from './types'

export function GuideDialog({
  payload,
  isAdmin,
}: {
  payload: OnboardingPayload
  isAdmin: boolean
}) {
  const action = useOnboardingAction()
  const open = payload.guide_used !== true

  function run(kind: 'complete' | 'dismiss') {
    action.mutate(kind)
  }

  return (
    <Dialog open={open}>
      <DialogContent
        showCloseButton={false}
        className='sm:max-w-md'
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>引导</DialogTitle>
          <DialogDescription>
            这台控制台还没有用过引导。升级上来的也会出现这一次。跳过或结束后不再弹出。
            {isAdmin
              ? ' 用法（个人自用或中转站）在欢迎页里选，只有管理员能改。'
              : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant='outline' asChild>
            <Link to='/welcome' search={{ setup: true }}>
              打开欢迎页
            </Link>
          </Button>
          <Button
            variant='outline'
            disabled={action.isPending}
            onClick={() => run('dismiss')}
          >
            跳过引导
          </Button>
          <Button disabled={action.isPending} onClick={() => run('complete')}>
            结束引导
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
