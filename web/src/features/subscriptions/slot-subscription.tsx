import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import type { Plan } from './index'
import { SubscriptionWizard, type WizardPreset } from './wizard'

export function SlotSubscription({ vm }: { vm: Vm }) {
  const me = useAuthStore((s) => s.me)
  const [preset, setPreset] = useState<WizardPreset | null>(null)
  const plans = useQuery({
    queryKey: ['subscription-plans', me?.user],
    queryFn: () => api<{ items: Plan[] }>('/api/panel/subscription-plans'),
    enabled: me?.role === 'admin',
  })
  if (me?.role !== 'admin') return null
  const boundPlans =
    plans.data?.items.filter((p) => p.vm_ids.includes(vm.id)) || []
  return (
    <div
      className='mt-2 space-y-1'
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {boundPlans.map((plan) => (
        <div key={plan.id} className='flex flex-wrap items-center gap-2'>
          <span className='text-xs text-muted-foreground'>
            {plan.name} · {plan.members} 位用户
            {plan.status === 'disabled' ? ' · 已停用' : ''}
          </span>
          <Button
            size='sm'
            variant='outline'
            disabled={plan.status === 'disabled' || !!vm.owner_user_id}
            aria-label={`分配订阅：${plan.name}`}
            onClick={() => setPreset({ planId: plan.id })}
          >
            分配订阅
          </Button>
        </div>
      ))}
      {!boundPlans.length && (
        <p className='text-xs text-muted-foreground'>
          {vm.owner_user_id ? '个人专属槽位' : '尚未绑定订阅'}
        </p>
      )}
      <Button
        size='sm'
        variant='outline'
        disabled={!!vm.owner_user_id || plans.isPending || !!plans.error}
        onClick={() => setPreset({ mode: 'new', vm })}
      >
        {boundPlans.length ? '新建共享套餐' : '创建订阅'}
      </Button>
      {plans.error && (
        <p className='text-xs text-destructive'>订阅信息加载失败</p>
      )}
      {preset && (
        <SubscriptionWizard preset={preset} onClose={() => setPreset(null)} />
      )}
    </div>
  )
}
