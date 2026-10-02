import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { Plan } from './index'
import { SubscriptionWizard } from './wizard'

export function SlotSubscription({ vm }: { vm: Vm }) {
  const me = useAuthStore((s) => s.me)
  const [open, setOpen] = useState(false)
  const plans = useQuery({
    queryKey: ['subscription-plans', me?.user],
    queryFn: () => api<{ items: Plan[] }>('/api/panel/subscription-plans'),
    enabled: me?.role === 'admin',
  })
  if (me?.role !== 'admin') return null
  const plan = plans.data?.items.find((p) => p.vm_ids.includes(vm.id))
  return (
    <div
      className='mt-2 space-y-1'
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <p className='text-xs text-muted-foreground'>
        {plan
          ? `${plan.name} · ${plan.members} 位用户`
          : vm.owner_user_id
            ? '个人专属槽位'
            : '尚未绑定订阅'}
      </p>
      <Button
        size='sm'
        variant='outline'
        disabled={
          !!vm.owner_user_id ||
          plans.isPending ||
          !!plans.error ||
          plan?.status === 'disabled'
        }
        onClick={() => setOpen(true)}
      >
        {plan ? '分配订阅' : '创建订阅'}
      </Button>
      {plans.error && (
        <p className='text-xs text-destructive'>订阅信息加载失败</p>
      )}
      {open && (
        <SubscriptionWizard
          preset={plan ? { planId: plan.id } : { mode: 'new', vm }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
