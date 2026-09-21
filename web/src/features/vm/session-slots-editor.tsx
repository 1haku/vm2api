import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
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
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { dashboardQueryOptions } from '@/features/overview/queries'
import { vmQueryOptions } from '@/features/vm/queries'

const SESSION_SLOT_STEPS = [1, 2, 4, 8, 12, 16, 20]

function withCurrent(current: number) {
  if (SESSION_SLOT_STEPS.includes(current)) return SESSION_SLOT_STEPS
  return [...SESSION_SLOT_STEPS, current].sort((a, b) => a - b)
}

export function SessionSlotsEditor({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const current = Number(vm.session_slots ?? 20)
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(String(current))

  const save = useMutation({
    mutationFn: () =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ session_slots: Number(value) }),
      }),
    onSuccess: async () => {
      toast.success('Session 槽位已热更新')
      await Promise.all([
        qc.invalidateQueries({ queryKey: vmQueryOptions(vm.id).queryKey }),
        qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
      ])
      setOpen(false)
    },
    onError: (error: Error) => toast.error(error.message || '更新失败'),
  })

  return (
    <>
      <Button
        size='sm'
        variant='ghost'
        className='h-6 px-2 text-xs'
        onClick={() => {
          setValue(String(current))
          setOpen(true)
        }}
      >
        编辑
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => !save.isPending && setOpen(next)}
      >
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>Session 槽位</DialogTitle>
            <DialogDescription>
              热更新可占用的 CLI 执行位，不重启内核，也不改变并发 / RPM。
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-1.5'>
            <Label htmlFor='vm-session-slots'>可用执行位</Label>
            <Select
              value={value}
              onValueChange={setValue}
              disabled={save.isPending}
            >
              <SelectTrigger id='vm-session-slots'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {withCurrent(current).map((slot) => (
                  <SelectItem key={slot} value={String(slot)}>
                    {slot}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              size='sm'
              variant='outline'
              disabled={save.isPending}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              size='sm'
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
