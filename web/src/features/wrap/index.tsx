import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { fmtBytes } from '@/lib/format'
import { wrapSyncKernelFails } from '@/lib/wrap-health'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { CardGridSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { dashboardQueryOptions } from '@/features/overview/queries'
import {
  inferenceEngineLabel,
  normalizeInferenceEngine,
} from '@/features/vm/engine-contract'
import {
  makeWrapSample,
  promoteWrapSample,
  repairWrapSample,
  syncWrapSample,
  uploadKernelBinary,
  wrapSampleQueryOptions,
  type WrapKernelPayload,
  type WrapSyncReport,
} from '@/features/wrap/queries'

const MAX_KERNEL_UPLOAD_BYTES = 32 * 1024 * 1024

function sampleDirLabel(dir?: string) {
  if (!dir) return 'share/wrap-cli'
  const parts = dir.replace(/\\/g, '/').split('/')
  const i = parts.lastIndexOf('share')
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

function kernelPathLabel(p?: string) {
  if (!p) return '—'
  const parts = p.replace(/\\/g, '/').split('/')
  const i = Math.max(parts.lastIndexOf('bin'), parts.lastIndexOf('wrap-cli'))
  if (i >= 0) return parts.slice(i).join('/')
  return parts.slice(-2).join('/')
}

const KERNEL_SOURCE_LABEL: Record<string, string> = {
  configured: '仓内最新 kernel',
  sample: '母样本 kernel',
  missing: '未找到 kernel',
}

function osOf(vm: Vm) {
  const runtime = vm.runtime && typeof vm.runtime === 'object' ? vm.runtime : {}
  const os = String(runtime.os || runtime.image || vm.kernel || '').trim()
  return os || '—'
}

function engineOf(vm: Vm) {
  return vm.resolved_inference_engine || vm.inference_engine || 'auto'
}

function toastSync(report: WrapSyncReport) {
  const total = report.total ?? 0
  const ok = report.ok_count ?? 0
  const failed = report.failed_count ?? 0
  const kernelFail = wrapSyncKernelFails(report.items)
  if (failed > 0) toast.error(`kernel 重装 ${ok}/${total}`)
  else if (kernelFail > 0)
    toast.error(`kernel 文件 ${ok}/${total}，进程未起来 ${kernelFail}`)
  else toast.success(`kernel 重装 ${ok}/${total}`)
}

function Flag({ ok, label }: { ok?: boolean; label: string }) {
  return (
    <div className='flex items-center justify-between gap-2 text-sm'>
      <span className='text-muted-foreground'>{label}</span>
      <span className={ok ? 'text-foreground' : 'text-destructive'}>
        {ok ? '有' : '缺'}
      </span>
    </div>
  )
}

function KernelPayload({ payload }: { payload?: WrapKernelPayload | null }) {
  return (
    <div className='space-y-2 text-sm'>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>来源</span>
        <span className='font-medium'>
          {KERNEL_SOURCE_LABEL[payload?.source || 'missing'] || '未找到 kernel'}
        </span>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>文件</span>
        <code className='text-xs'>{kernelPathLabel(payload?.path)}</code>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>大小</span>
        <span className='font-mono text-xs'>
          {payload?.size ? fmtBytes(payload.size) : '—'}
        </span>
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>mtime</span>
        <span className='font-mono text-xs'>{payload?.mtime || '—'}</span>
      </div>
    </div>
  )
}

export function WrapSamplePage() {
  const qc = useQueryClient()
  const sample = useQuery(wrapSampleQueryOptions())
  const dash = useQuery(dashboardQueryOptions())
  const vms: Vm[] = dash.data?.vms || []
  const [restart, setRestart] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [promoteId, setPromoteId] = useState<string | null>(null)
  const [makeOpen, setMakeOpen] = useState(false)
  const [glibcVm, setGlibcVm] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const rustVms = useMemo(
    () => vms.filter((vm) => engineOf(vm) === 'rust'),
    [vms]
  )

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: wrapSampleQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const sync = useMutation({
    mutationFn: () =>
      syncWrapSample({
        ids: selected.length ? selected : undefined,
        restart,
      }),
    onSuccess: async (report) => {
      toastSync(report)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const promote = useMutation({
    mutationFn: (id: string) => promoteWrapSample(id),
    onSuccess: async (_data, id) => {
      toast.success(`已从 ${id} 晋升 wrap 文件`)
      setPromoteId(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const make = useMutation({
    mutationFn: () => makeWrapSample({ glibc_vm: glibcVm || undefined }),
    onSuccess: async () => {
      toast.success('已重整 wrap 文件')
      setMakeOpen(false)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const repair = useMutation({
    mutationFn: (id: string) => repairWrapSample(id),
    onSuccess: async (report, id) => {
      const kernelOk = report.kernel?.ok !== false
      toast[kernelOk ? 'success' : 'error'](
        kernelOk ? `${id} 已重装 kernel` : `${id} kernel 文件已写入，进程未起来`
      )
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const upload = useMutation({
    mutationFn: (file: File) => uploadKernelBinary(file),
    onSuccess: async () => {
      toast.success('已替换仓内 kernel，请选择槽位重装')
      setUploadFile(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  const toggle = (id: string, on: boolean) => {
    setSelected((cur) =>
      on ? Array.from(new Set([...cur, id])) : cur.filter((x) => x !== id)
    )
  }

  const pickKernelFile = (file?: File) => {
    if (!file) return
    if (file.size > MAX_KERNEL_UPLOAD_BYTES) {
      toast.error('kernel 不能超过 32MB')
      return
    }
    if (!file.size) {
      toast.error('kernel 文件为空')
      return
    }
    setUploadFile(file)
  }

  const data = sample.data
  const complete = data?.ok === true

  return (
    <PageHeader
      title={VIEW_TITLES.wrap}
      extra={
        <div className='flex gap-2'>
          <input
            ref={fileRef}
            type='file'
            className='hidden'
            onChange={(event) => {
              pickKernelFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
          <Button
            size='sm'
            variant='outline'
            disabled={upload.isPending}
            loading={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            上传 kernel
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={make.isPending}
            loading={make.isPending}
            onClick={() => setMakeOpen(true)}
          >
            重整 wrap 文件
          </Button>
          <Button
            size='sm'
            disabled={!complete || sync.isPending}
            loading={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {selected.length
              ? `重装所选 ${selected.length} 槽`
              : '全部重装 kernel'}
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={sample.isLoading || dash.isLoading}
        error={sample.error || dash.error}
        skeleton={
          <CardGridSkeleton cards={2} className='grid gap-4 lg:grid-cols-2' />
        }
      >
        <p className='mb-4 max-w-3xl text-sm leading-relaxed text-muted-foreground'>
          用仓内最新 linux amd64 <code>kin-kernel</code> 重装所选 VM 的槽内
          kernel。不改凭证、不改 SOCKS、不 docker rm。wrap CLI（cli-node / glibc
          shim）仍随同步铺到槽内。
        </p>
        <div className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle>当前 kernel</CardTitle>
            </CardHeader>
            <CardContent className='space-y-2'>
              <KernelPayload payload={data?.kernel} />
              <div className='flex items-center justify-between gap-2 text-sm'>
                <span className='text-muted-foreground'>目录</span>
                <code className='text-xs'>{sampleDirLabel(data?.dir)}</code>
              </div>
              <Flag ok={data?.kernel_bin} label='kernel.bin' />
              <Flag ok={data?.wrapper} label='kernel wrapper' />
              <Flag ok={data?.glibc_shim} label='glibc 2.39 shim' />
              <div className='mt-3 flex items-center gap-2 text-sm'>
                <Checkbox
                  checked={restart}
                  onCheckedChange={(v) => setRestart(v === true)}
                />
                <label>
                  同步后重启 rust kernel（默认开，让 CONNECT 桥跟着起来）
                </label>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>怎么用</CardTitle>
            </CardHeader>
            <CardContent className='space-y-2 text-sm leading-relaxed text-muted-foreground'>
              <p>
                1. 默认用仓内 <code>bin/kin-kernel</code>（
                <code>KIN_KERNEL_BIN</code>
                ）。旧母样本 ELF 不会盖回去。
              </p>
              <p>
                2. 「上传
                kernel」只替换仓内二进制。选槽再点重装，运行中的进程才会加载新文件。
              </p>
              <p>
                3. 单槽「重装 kernel」只修这一台，不碰凭证。覆盖在跑的文件会先
                unlink 再换上。
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className='mt-4'>
          <CardHeader>
            <CardTitle>槽位</CardTitle>
          </CardHeader>
          <CardContent>
            {vms.length === 0 ? (
              <EmptyState
                reason='还没有槽位。'
                actionLabel='去虚拟机'
                to='/vm'
              />
            ) : (
              <div className='overflow-x-auto'>
                <table className='w-full text-sm'>
                  <thead className='text-left text-muted-foreground'>
                    <tr>
                      <th className='w-8 py-2 font-medium'>选</th>
                      <th className='py-2 font-medium'>槽</th>
                      <th className='py-2 font-medium'>OS</th>
                      <th className='py-2 font-medium'>引擎</th>
                      <th className='py-2 font-medium'>母本</th>
                      <th className='py-2 text-right font-medium'>动作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vms.map((vm) => {
                      const engine = engineOf(vm)
                      const rust = engine === 'rust'
                      const source = data?.meta?.source_vm === vm.id
                      return (
                        <tr key={vm.id} className='border-b last:border-0'>
                          <td className='py-2'>
                            <Checkbox
                              checked={selected.includes(vm.id)}
                              onCheckedChange={(v) => toggle(vm.id, v === true)}
                              aria-label={`选择 ${vm.id}`}
                            />
                          </td>
                          <td className='py-2 font-mono text-xs'>
                            <Link
                              to='/vm/$id'
                              params={{ id: vm.id }}
                              className='underline underline-offset-4'
                            >
                              {vm.id}
                            </Link>
                          </td>
                          <td className='py-2 text-muted-foreground'>
                            {osOf(vm)}
                          </td>
                          <td className='py-2'>
                            {inferenceEngineLabel(
                              normalizeInferenceEngine(engine, 'auto')
                            )}
                          </td>
                          <td className='py-2 text-muted-foreground'>
                            {source
                              ? '当前来源'
                              : rust
                                ? '可晋升'
                                : 'go 槽只收文件'}
                          </td>
                          <td className='py-2'>
                            <div className='flex justify-end gap-2'>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!rust || promote.isPending}
                                onClick={() => setPromoteId(vm.id)}
                              >
                                晋升 wrap 文件
                              </Button>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!complete || repair.isPending}
                                loading={
                                  repair.isPending && repair.variables === vm.id
                                }
                                onClick={() => repair.mutate(vm.id)}
                              >
                                重装 kernel
                              </Button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {rustVms.length === 0 ? (
              <p className='mt-3 text-xs text-muted-foreground'>
                没有 rust cli-hop 槽时仍可同步文件，但不会启动 wrap kernel。
              </p>
            ) : null}
          </CardContent>
        </Card>
      </QueryGate>
      <ConfirmDialog
        open={!!promoteId}
        onOpenChange={(open) => {
          if (!open) setPromoteId(null)
        }}
        title='覆盖 wrap 母样本？'
        desc={`用 ${promoteId || ''} 槽内已验证的 .kin 覆盖 share/wrap-cli。不会复制凭证或 SOCKS。下次重装仍优先仓内最新 kernel。`}
        confirmText='晋升 wrap 文件'
        cancelBtnText='取消'
        isLoading={promote.isPending}
        handleConfirm={() => {
          if (promoteId) promote.mutate(promoteId)
        }}
      />
      <ConfirmDialog
        open={makeOpen}
        onOpenChange={setMakeOpen}
        title='重整 wrap 文件？'
        desc='用当前 share/wrap-cli 里已有的 cli-node，补 kernel wrapper / shim，并叠上仓内最新 kernel。缺 cli-node 会失败。Debian 12 可从一台 Ubuntu 槽拷 glibc 2.39 shim。'
        confirmText='重整'
        cancelBtnText='取消'
        isLoading={make.isPending}
        handleConfirm={() => make.mutate()}
      >
        <div className='space-y-1'>
          <p className='text-sm'>glibc shim 来源槽（可选）</p>
          <Select
            value={glibcVm || 'none'}
            onValueChange={(v) => setGlibcVm(v === 'none' ? '' : v)}
          >
            <SelectTrigger aria-label='glibc shim 来源槽'>
              <SelectValue placeholder='不拷 shim' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='none'>不拷 shim</SelectItem>
              {vms.map((vm) => (
                <SelectItem key={vm.id} value={vm.id}>
                  {vm.id} · {osOf(vm)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!uploadFile}
        onOpenChange={(open) => {
          if (!open) setUploadFile(null)
        }}
        title='替换 kernel 二进制？'
        desc={`将用 ${uploadFile?.name || '所选文件'}（${fmtBytes(uploadFile?.size || 0)}）覆盖仓内 bin/kin-kernel 与 share/wrap-cli/kin-kernel.bin。不会自动同步槽位。`}
        confirmText='替换'
        cancelBtnText='取消'
        isLoading={upload.isPending}
        handleConfirm={() => {
          if (uploadFile) upload.mutate(uploadFile)
        }}
      />
    </PageHeader>
  )
}
