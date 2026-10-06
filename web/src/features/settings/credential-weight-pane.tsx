import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { QueryGate } from '@/components/query-gate'
import { SettingRow } from '@/components/setting-row'
import { dashboardQueryOptions } from '@/features/overview/queries'

const MANUAL_LEVELS = Array.from({ length: 10 }, (_, index) => index + 1)

function scheduleLevelOf(vm: Vm): number | null {
  const level = Number(vm.schedule_level)
  return Number.isInteger(level) && level >= 1 && level <= 10 ? level : null
}

function CredentialWeightRow({ vm }: { vm: Vm }) {
  const qc = useQueryClient()
  const level = scheduleLevelOf(vm)
  const currentSelection =
    vm.schedule_level_mode === 'manual' && level !== null
      ? String(level)
      : 'auto'
  const [selection, setSelection] = useState(currentSelection)

  useEffect(() => setSelection(currentSelection), [currentSelection])

  const save = useMutation({
    mutationFn: (next: string) =>
      api(`/api/panel/vms/${encodeURIComponent(vm.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          schedule_level: next === 'auto' ? null : Number(next),
        }),
      }),
    onSuccess: async (_data, next) => {
      toast.success(
        next === 'auto' ? '已恢复自动调度等级' : `已设为手动 ${next} 级`
      )
      await qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey })
    },
    onError: (error: Error) => {
      setSelection(currentSelection)
      toast.error(error.message || '调度等级更新失败')
    },
  })

  const identity = [vm.email, vm.id].filter(Boolean).join(' · ')
  const levelText = level === null ? '未知' : `${level} 级`
  const autoOptionLabel =
    vm.schedule_level_mode === 'auto'
      ? `自动（当前 ${levelText}）`
      : '自动（恢复系统计算）'
  const modeText =
    vm.schedule_level_mode === 'manual'
      ? `手动模式 · 当前 ${levelText}`
      : level === null
        ? '自动模式 · 网关未返回有效等级'
        : `自动模式 · 当前 ${levelText} · 根据 7D 重置倒计时计算`

  return (
    <SettingRow
      label={vm.name || vm.id}
      desc={
        <>
          <span className='block'>{modeText}</span>
          {identity ? <span className='block'>{identity}</span> : null}
        </>
      }
    >
      <Select
        value={selection}
        onValueChange={(next) => {
          setSelection(next)
          save.mutate(next)
        }}
        disabled={save.isPending}
      >
        <SelectTrigger
          className='w-48'
          aria-label={`${vm.name || vm.id} 调度等级`}
          aria-busy={save.isPending}
        >
          {save.isPending ? (
            <span className='flex items-center gap-2' aria-live='polite'>
              <Loader2 className='size-4 animate-spin' aria-hidden='true' />
              保存中…
            </span>
          ) : (
            <SelectValue />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value='auto'>{autoOptionLabel}</SelectItem>
          {MANUAL_LEVELS.map((value) => (
            <SelectItem key={value} value={String(value)}>
              手动 {value} 级
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  )
}

function CredentialWeightSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className='h-5 w-32' />
        <Skeleton className='h-4 w-full max-w-xl' />
      </CardHeader>
      <CardContent className='space-y-3'>
        {[1, 2, 3].map((row) => (
          <div
            key={row}
            className='flex items-center justify-between gap-6 py-2'
          >
            <div className='space-y-2'>
              <Skeleton className='h-4 w-28' />
              <Skeleton className='h-3 w-52' />
            </div>
            <Skeleton className='h-9 w-48' />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

export function CredentialWeightPane() {
  const dashboard = useQuery(dashboardQueryOptions())
  const credentialVms = (dashboard.data?.vms || []).filter(
    (vm) => vm.has_token || vm.has_refresh
  )

  return (
    <QueryGate
      loading={dashboard.isLoading}
      error={dashboard.error}
      skeleton={<CredentialWeightSkeleton />}
    >
      <Card>
        <CardHeader>
          <CardTitle>凭证调度等级</CardTitle>
          <CardDescription className='max-w-3xl leading-5'>
            等级越高越先参与普通调度。自动模式按 Claude 7D 重置倒计时计算 1～7
            级；手动模式可设 1～10 级。健康粘性会话仍优先，同等级内按账号池策略
            （平衡 / 填充）开新席位。
          </CardDescription>
        </CardHeader>
        <CardContent className='divide-y'>
          {credentialVms.length ? (
            credentialVms.map((vm) => (
              <CredentialWeightRow key={vm.id} vm={vm} />
            ))
          ) : (
            <EmptyState
              reason='暂无凭证槽，请先导入凭证后再配置调度等级。'
              actionLabel='导入凭证'
              to='/import'
            />
          )}
        </CardContent>
      </Card>
    </QueryGate>
  )
}
