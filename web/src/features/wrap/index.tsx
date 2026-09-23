import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import type { Vm } from '@/types/panel-vm'
import { toast } from 'sonner'
import { fmtBytes } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
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
  installReleaseKernel,
  makeWrapSample,
  promoteWrapSample,
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

function osOf(vm: Vm) {
  const runtime = vm.runtime && typeof vm.runtime === 'object' ? vm.runtime : {}
  const os = String(runtime.os || runtime.image || vm.kernel || '').trim()
  return os || '—'
}

function engineOf(vm: Vm) {
  return vm.resolved_inference_engine || vm.inference_engine || 'auto'
}

type HopJob = {
  phase: 'download' | 'slots' | 'done'
  done: number
  total: number
  current: string
  failed: string[]
}

function hopProgressValue(job: HopJob) {
  if (job.phase === 'download') return 8
  if (!job.total) return 0
  return Math.round((job.done / job.total) * 100)
}

function slotSyncFailed(report: WrapSyncReport, id: string) {
  const item = report.items?.find((row) => row.id === id) || report.items?.[0]
  if (!item) return report.ok === false
  if (item.ok === false) return true
  return item.kernel?.ok === false
}

function HopProgress({ job }: { job: HopJob }) {
  const label =
    job.phase === 'download'
      ? '拉取 GitHub 最新 kin-kernel 和 cli-node'
      : job.phase === 'done'
        ? job.failed.length
          ? `内核重装结束，失败 ${job.failed.length}`
          : `最新内核已重装 ${job.done}/${job.total}`
        : `正在换 ${job.current || '槽'} 的 cli-node 和 kin-kernel`
  return (
    <div className='space-y-1.5'>
      <div className='flex items-center justify-between gap-3 text-xs text-muted-foreground'>
        <span>{label}</span>
        <span>
          {job.phase === 'download' ? '下载中' : `${job.done}/${job.total}`}
        </span>
      </div>
      <Progress
        value={hopProgressValue(job)}
        className='h-2'
        indicatorClassName={job.phase === 'done' ? undefined : 'animate-pulse'}
      />
      {job.failed.length ? (
        <p className='text-xs text-destructive'>
          失败：{job.failed.join('、')}
        </p>
      ) : null}
    </div>
  )
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

function KernelPayload({
  payload,
  kind = 'kernel',
}: {
  payload?: WrapKernelPayload | null
  kind?: 'kernel' | 'cli'
}) {
  const label =
    payload?.source === 'configured'
      ? '仓内最新 kernel'
      : payload?.source === 'sample'
        ? kind === 'cli'
          ? '仓内 cli-node'
          : '母样本 kernel'
        : kind === 'cli'
          ? '未找到 cli-node'
          : '未找到 kernel'
  return (
    <div className='space-y-2 text-sm'>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-muted-foreground'>来源</span>
        <span className='font-medium'>{label}</span>
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
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [hopOpen, setHopOpen] = useState(false)
  const [hopIds, setHopIds] = useState<string[]>([])
  const [pullLatest, setPullLatest] = useState(true)
  const [hopJob, setHopJob] = useState<HopJob | null>(null)
  const [hopBusy, setHopBusy] = useState(false)
  const hopToken = useRef(0)
  const fileRef = useRef<HTMLInputElement>(null)

  const rustVms = useMemo(
    () => vms.filter((vm) => engineOf(vm) === 'rust'),
    [vms]
  )
  const reinstallIds = selected.length ? selected : vms.map((vm) => vm.id)

  const invalidate = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: wrapSampleQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: dashboardQueryOptions().queryKey }),
    ])
  }

  const openHop = (ids: string[], pull: boolean) => {
    setHopIds(ids)
    setPullLatest(pull)
    setHopOpen(true)
  }

  const runHop = async (ids: string[], pull: boolean) => {
    if (!ids.length || hopBusy) return
    const token = hopToken.current + 1
    hopToken.current = token
    const alive = () => hopToken.current === token
    setHopBusy(true)
    setHopJob({
      phase: pull ? 'download' : 'slots',
      done: 0,
      total: ids.length,
      current: ids[0] || '',
      failed: [],
    })
    const failed: string[] = []
    try {
      if (pull) {
        await installReleaseKernel({ ids: [], restart: false })
        if (!alive()) return
      }
      for (let i = 0; i < ids.length; i++) {
        if (!alive()) return
        const id = ids[i]
        setHopJob({
          phase: 'slots',
          done: i,
          total: ids.length,
          current: id,
          failed: [...failed],
        })
        try {
          const report = await syncWrapSample({ ids: [id], restart })
          if (slotSyncFailed(report, id)) failed.push(id)
        } catch {
          failed.push(id)
        }
      }
      if (!alive()) return
      setHopJob({
        phase: 'done',
        done: ids.length,
        total: ids.length,
        current: '',
        failed: [...failed],
      })
      if (failed.length) {
        toast.error(`内核重装 ${ids.length - failed.length}/${ids.length}`)
      } else {
        toast.success(`内核重装 ${ids.length}/${ids.length}`)
      }
      await invalidate()
    } catch (error) {
      if (!alive()) return
      toast.error(error instanceof Error ? error.message : '内核重装失败')
      setHopJob((cur) =>
        cur
          ? { ...cur, phase: 'done', failed: failed.length ? failed : ['下载'] }
          : cur
      )
    } finally {
      if (alive()) setHopBusy(false)
    }
  }

  const promote = useMutation({
    mutationFn: (id: string) => promoteWrapSample(id),
    onSuccess: async (_data, id) => {
      toast.success(`已把 ${id} 收成母本`)
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

  const upload = useMutation({
    mutationFn: (file: File) => uploadKernelBinary(file),
    onSuccess: async () => {
      toast.success('已写入仓内 kernel。用 cli-hop 重装铺到槽')
      setUploadFile(null)
      await invalidate()
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const releaseUpdate = useMutation({
    mutationFn: () => installReleaseKernel({ ids: [], restart: false }),
    onSuccess: async (result) => {
      setReleaseOpen(false)
      const tag = result.release?.tag || 'Release'
      const cli = result.release?.cli_node_size
        ? `，cli-node ${fmtBytes(result.release.cli_node_size)}`
        : ''
      toast.success(`已下载 ${tag}${cli}。尚未铺到槽`)
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
        <div className='flex flex-wrap gap-2'>
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
            disabled={releaseUpdate.isPending || hopBusy}
            loading={releaseUpdate.isPending}
            onClick={() => setReleaseOpen(true)}
          >
            拉取 kernel 和 cli-node
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={upload.isPending || hopBusy}
            loading={upload.isPending}
            onClick={() => fileRef.current?.click()}
          >
            本地上传
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={make.isPending || hopBusy}
            loading={make.isPending}
            onClick={() => setMakeOpen(true)}
          >
            重整母本
          </Button>
          <Button
            size='sm'
            disabled={!complete || !reinstallIds.length || hopBusy}
            loading={hopBusy && hopIds.length !== 1}
            onClick={() => openHop(reinstallIds, true)}
          >
            {selected.length
              ? `重装 kernel 和 cli-node ${selected.length}`
              : '重装 kernel 和 cli-node'}
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
          槽内服务重装。先拉取 GitHub 最新 kernel 和 cli-node，或上传本地
          kernel。右侧可一键把 最新 <code>cli-node</code> 和 cli-hop{' '}
          <code>kin-kernel</code> 铺进全部槽。不改凭证、不改 SOCKS、不删容器。
        </p>
        <div className='grid gap-4 lg:grid-cols-2'>
          <Card>
            <CardHeader>
              <CardTitle>当前内核</CardTitle>
            </CardHeader>
            <CardContent className='space-y-2'>
              <div className='text-xs font-medium text-muted-foreground'>
                kin-kernel
              </div>
              <KernelPayload payload={data?.kernel} />
              <div className='pt-2 text-xs font-medium text-muted-foreground'>
                cli-node
              </div>
              <KernelPayload payload={data?.cli_node} kind='cli' />
              {data?.meta?.release_tag ? (
                <div className='flex items-center justify-between gap-2 text-sm'>
                  <span className='text-muted-foreground'>GitHub</span>
                  <span className='font-mono text-xs'>
                    {data.meta.release_tag}
                  </span>
                </div>
              ) : null}
              <div className='flex items-center justify-between gap-2 text-sm'>
                <span className='text-muted-foreground'>目录</span>
                <code className='text-xs'>{sampleDirLabel(data?.dir)}</code>
              </div>
              <Flag ok={Boolean(data?.cli_node?.size)} label='cli-node' />
              <Flag ok={data?.kernel_bin} label='kernel.bin' />
              <Flag ok={data?.wrapper} label='kernel wrapper' />
              <Flag ok={data?.glibc_shim} label='glibc 2.39 shim' />
              <div className='mt-3 flex items-center gap-2 text-sm'>
                <Checkbox
                  checked={restart}
                  onCheckedChange={(v) => setRestart(v === true)}
                />
                <label>铺完后重启 rust kernel，让 cli-hop 用上新二进制</label>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>内核重装</CardTitle>
            </CardHeader>
            <CardContent className='space-y-3 text-sm leading-relaxed text-muted-foreground'>
              <p>
                一键把最新内核铺进全部槽。内核包括 <code>cli-node</code>
                （Claude）和 cli-hop <code>kin-kernel</code>
                。先从 GitHub Release 拉这两个 linux amd64
                文件，再铺进槽。不改凭证、不改 SOCKS、不删容器。
              </p>
              <Button
                size='sm'
                disabled={!complete || vms.length === 0 || hopBusy}
                loading={hopBusy && hopIds.length > 1}
                onClick={() =>
                  openHop(
                    vms.map((vm) => vm.id),
                    true
                  )
                }
              >
                一键全部重装最新内核
              </Button>
              {hopJob ? <HopProgress job={hopJob} /> : null}
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
                            {source ? '当前母本' : rust ? '可收成' : '只收文件'}
                          </td>
                          <td className='py-2'>
                            <div className='flex justify-end gap-2'>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!rust || promote.isPending || hopBusy}
                                onClick={() => setPromoteId(vm.id)}
                              >
                                晋升母本
                              </Button>
                              <Button
                                size='sm'
                                variant='outline'
                                disabled={!complete || hopBusy}
                                loading={
                                  hopBusy &&
                                  hopIds.length === 1 &&
                                  hopIds[0] === vm.id
                                }
                                onClick={() => openHop([vm.id], false)}
                              >
                                替换此槽
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
                没有 rust cli-hop 槽时仍会铺文件，但不会重启 kernel。
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
        title='收成母本？'
        desc={`把 ${promoteId || '此槽'} 里已跑通的 cli-node 收成以后重装用的母本。不拷凭证。kernel 仍用仓内文件。`}
        confirmText='晋升'
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
        title='上传 kernel？'
        desc={`用 ${uploadFile?.name || '所选文件'}（${fmtBytes(uploadFile?.size || 0)}）覆盖仓内 kernel。不会自动改槽。`}
        confirmText='上传'
        cancelBtnText='取消'
        isLoading={upload.isPending}
        handleConfirm={() => {
          if (uploadFile) upload.mutate(uploadFile)
        }}
      />
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title='拉取 GitHub 最新 kernel 和 cli-node？'
        desc='下载最新 Release 的 linux amd64 kin-kernel 和 cli-node 到仓内。不改槽、不重启。'
        confirmText='下载'
        cancelBtnText='取消'
        isLoading={releaseUpdate.isPending}
        handleConfirm={() => releaseUpdate.mutate()}
      />
      <ConfirmDialog
        open={hopOpen}
        onOpenChange={(open) => {
          if (!open) setHopOpen(false)
        }}
        title={
          hopIds.length === 1
            ? `替换 ${hopIds[0]}？`
            : hopIds.length === vms.length
              ? '一键重装全部槽的最新内核？'
              : `重装所选 ${hopIds.length} 槽？`
        }
        desc={
          hopIds.length === 1
            ? '用仓内当前 cli-node 和 cli-hop kin-kernel 替换这一台。不改凭证，不删容器。'
            : pullLatest
              ? '先从 GitHub 拉 kin-kernel 和 cli-node，再逐槽换上。不改凭证，不删容器。'
              : '逐槽换上仓内 cli-node（Claude）和 cli-hop kin-kernel，并显示进度。不改凭证，不删容器。'
        }
        confirmText={
          hopIds.length === 1
            ? '替换'
            : hopIds.length === vms.length
              ? '全部重装'
              : '开始重装'
        }
        cancelBtnText='取消'
        isLoading={hopBusy}
        handleConfirm={() => {
          const ids = hopIds
          const pull = ids.length === 1 ? false : pullLatest
          setHopOpen(false)
          void runHop(ids, pull)
        }}
      >
        {hopIds.length === 1 ? null : (
          <label className='flex items-center gap-2 text-sm'>
            <Checkbox
              checked={pullLatest}
              onCheckedChange={(v) => setPullLatest(v === true)}
            />
            先拉取 GitHub 最新 kernel 和 cli-node
          </label>
        )}
      </ConfirmDialog>
    </PageHeader>
  )
}
