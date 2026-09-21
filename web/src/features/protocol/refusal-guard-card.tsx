import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RefusalGuardConfig } from '@/types/panel-routing'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtExpiresAt } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { SettingRow } from '@/components/setting-row'
import { refusalGuardsQueryOptions } from '@/features/protocol/queries'

function shortFp(fp: string) {
  const s = String(fp || '')
  if (s.length <= 16) return s
  return `${s.slice(0, 10)}…${s.slice(-6)}`
}

export function RefusalGuardCard() {
  const qc = useQueryClient()
  const q = useQuery(refusalGuardsQueryOptions())
  const [clearOpen, setClearOpen] = useState(false)
  const [deleteFp, setDeleteFp] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: async (data) => {
      toast.success(data.enabled ? '已开启拒答缓存' : '已关闭拒答缓存')
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const remove = useMutation({
    mutationFn: (fingerprint: string) =>
      api<RefusalGuardConfig>(`/api/panel/refusal-guards/${fingerprint}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('已删除该指纹')
      setDeleteFp(null)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const clear = useMutation({
    mutationFn: () =>
      api<RefusalGuardConfig>('/api/panel/refusal-guards', {
        method: 'DELETE',
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: async () => {
      toast.success('已清空拒答缓存')
      setClearOpen(false)
      await qc.invalidateQueries({
        queryKey: refusalGuardsQueryOptions().queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>拒答缓存</CardTitle>
        </CardHeader>
        <CardContent className='text-sm text-destructive'>
          {(q.error as Error).message}
        </CardContent>
      </Card>
    )
  }
  if (!q.data) return null
  const data = q.data
  const deleting = data.items.find((item) => item.fingerprint === deleteFp)

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between gap-3'>
        <CardTitle>拒答缓存</CardTitle>
        <Button
          size='sm'
          variant='outline'
          disabled={!data.count || clear.isPending}
          onClick={() => setClearOpen(true)}
        >
          清空
        </Button>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow
          label='拦截重复拒答'
          desc='上游 AUP / stop_reason=refusal 落库后，同样 model + prompt 直接 500，不再 hop。与蒸馏拦截独立。环境变量 REFUSAL_GUARD=0 强制关闭'
        >
          <Switch
            checked={data.enabled}
            disabled={save.isPending}
            onCheckedChange={(v) => save.mutate(v)}
          />
        </SettingRow>
        <p className='py-3 text-xs text-muted-foreground'>
          0 注入时蒸馏不拦，本缓存仍生效。指纹含模型，opus-5 拒了不会挡住
          opus-4-8。
        </p>
        <div className='space-y-2 py-3'>
          <p className='text-sm'>
            已缓存 {data.count} 条
            {data.items.length < data.count
              ? `，显示最近 ${data.items.length} 条`
              : ''}
          </p>
          {!data.items.length ? (
            <p className='text-xs text-muted-foreground'>
              还没有上游拒答指纹。
            </p>
          ) : (
            <ul className='space-y-2'>
              {data.items.map((item) => (
                <li
                  key={item.fingerprint}
                  className='flex flex-wrap items-start justify-between gap-2 rounded-md border p-2'
                >
                  <div className='min-w-0 flex-1 space-y-0.5'>
                    <p className='truncate text-sm'>
                      {item.preview || '（无预览）'}
                    </p>
                    <p className='font-mono text-xs text-muted-foreground'>
                      {item.model || '—'} · {shortFp(item.fingerprint)} · 命中{' '}
                      {item.hit_count} · {fmtExpiresAt(item.last_seen_at)}
                    </p>
                  </div>
                  <Button
                    size='sm'
                    variant='ghost'
                    onClick={() => setDeleteFp(item.fingerprint)}
                  >
                    删除
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title='清空拒答缓存'
        desc='清空后同样请求会再次 hop 上游。须 confirm: true。'
        confirmText='清空'
        cancelBtnText='取消'
        destructive
        isLoading={clear.isPending}
        handleConfirm={() => clear.mutate()}
      />
      <ConfirmDialog
        open={!!deleteFp}
        onOpenChange={(open) => {
          if (!open) setDeleteFp(null)
        }}
        title='删除这条指纹'
        desc={`删除后「${deleting?.preview || shortFp(deleteFp || '')}」会再次打上游。`}
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        isLoading={remove.isPending}
        handleConfirm={() => {
          if (deleteFp) remove.mutate(deleteFp)
        }}
      />
    </Card>
  )
}
