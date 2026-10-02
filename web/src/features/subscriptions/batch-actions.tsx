import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Subscription } from './index'

const names: Record<string, string> = {
  renew: '批量续期',
  suspend: '批量暂停',
  resume: '批量恢复',
}
export function BatchActions({
  items,
  onDone,
}: {
  items: Subscription[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<{
    action: string
    items: Subscription[]
  } | null>(null)
  const [days, setDays] = useState(30)
  const mutation = useMutation({
    mutationFn: () =>
      api('/api/panel/subscriptions/batch', {
        method: 'POST',
        body: JSON.stringify({
          ids: draft?.items.map((s) => s.id),
          action: draft?.action,
          days,
        }),
      }),
    onSuccess: async () => {
      toast.success(`已处理 ${draft?.items.length} 个订阅`)
      setOpen(false)
      onDone()
      await Promise.all(
        [
          'subscriptions',
          'subscription-plans',
          'subscription-events',
          'subscription-overview',
        ].map((k) => qc.invalidateQueries({ queryKey: [k] }))
      )
    },
    onError: (e: Error) => toast.error(e.message),
  })
  return (
    <>
      <div className='flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 p-3'>
        <span className='mr-auto text-sm text-muted-foreground'>
          已选 {items.length} 个订阅 · 每批最多 100 个
        </span>
        {Object.entries(names).map(([action, label]) => (
          <Button
            key={action}
            size='sm'
            variant='outline'
            disabled={!items.length || items.length > 100}
            onClick={() => {
              setDays(30)
              mutation.reset()
              setDraft({ action, items: [...items] })
              setOpen(true)
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <Dialog
        open={open}
        onOpenChange={(open) => !open && !mutation.isPending && setOpen(false)}
      >
        <DialogContent className='max-h-[90dvh] overflow-y-auto'>
          <DialogHeader>
            <DialogTitle>
              {draft && names[draft.action]} · {draft?.items.length} 个订阅
            </DialogTitle>
            <DialogDescription>
              {draft?.action === 'renew'
                ? '未到期的从原到期日延长，已到期的从现在延长；额度和历史账目保留。'
                : draft?.action === 'suspend'
                  ? '暂停后这些订阅的密钥将无法发起新调用，历史记录保留。'
                  : '恢复所选订阅，已到期的订阅需先续期。'}{' '}
              任一订阅无法处理时，整批保持不变。
            </DialogDescription>
          </DialogHeader>
          <ul className='max-h-48 space-y-2 overflow-y-auto rounded-lg border p-3 text-sm'>
            {draft?.items.map((s) => (
              <li key={s.id}>
                {s.username} · {s.plan_name}
                <span className='block text-xs text-muted-foreground'>
                  当前到期：{new Date(s.expires_at).toLocaleString('zh-CN')}
                </span>
              </li>
            ))}
          </ul>
          {draft?.action === 'renew' && (
            <label className='space-y-2 text-sm'>
              续期天数
              <Input
                aria-label='批量续期天数'
                type='number'
                min={1}
                max={3650}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            </label>
          )}
          {mutation.error && (
            <p role='alert' className='text-sm text-destructive'>
              {mutation.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              variant='outline'
              disabled={mutation.isPending}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={
                mutation.isPending ||
                (draft?.action === 'renew' &&
                  (!Number.isInteger(days) || days < 1 || days > 3650))
              }
              loading={mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              确认{draft && names[draft.action]}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
