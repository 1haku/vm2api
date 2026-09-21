import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { VIEW_TITLES } from '@/config/nav'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { QueryGate } from '@/components/query-gate'
import { modelPolicyQueryOptions } from '@/features/models/queries'
import { ModelAdvanced } from './model-advanced'
import { ModelRow } from './model-row'
import {
  type BetaFilter,
  type CatalogMode,
  type ModelEntry,
  type ModelParams,
  type ModelPolicy,
  type Pass1mMode,
  type PolicyDefaults,
  type PolicyPayload,
  applyPassContext1m,
  cloneJson,
  familyOptions,
  filterModels,
  hydratePolicy,
  listModelEntries,
  policyStats,
} from './policy'

const BETA_FILTERS: [BetaFilter, string][] = [
  ['all', '全部'],
  ['pass', '透传 1M'],
  ['strip', '剥离'],
  ['inherit', '跟随通配'],
]

export function ModelsPage() {
  const qc = useQueryClient()
  const [catalogPlatform, setCatalogPlatform] = useState<
    'anthropic' | 'openai'
  >('anthropic')
  const q = useQuery(modelPolicyQueryOptions(catalogPlatform))
  const [draft, setDraft] = useState<ModelPolicy>(() => hydratePolicy(null))
  const [savedSnap, setSavedSnap] = useState('')
  const [qtext, setQtext] = useState('')
  const [family, setFamily] = useState('all')
  const [beta, setBeta] = useState<BetaFilter>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    if (!q.data) return
    const pol = hydratePolicy(q.data.policy)
    setDraft(pol)
    setSavedSnap(JSON.stringify(pol))
  }, [q.data])

  const all = useMemo(() => listModelEntries(draft), [draft])
  const effectiveIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of q.data?.effective || []) {
      if (row.id) ids.add(row.id)
    }
    return ids
  }, [q.data?.effective])
  const visible = useMemo(
    () => filterModels(all, draft, qtext, family, beta),
    [all, draft, qtext, family, beta]
  )
  const families = useMemo(() => familyOptions(all), [all])
  const stats = policyStats(all, draft, effectiveIds)
  const dirty = JSON.stringify(draft) !== savedSnap

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!dirty) return
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  // beforeunload only covers tab close/reload — client-side route changes
  // (sidebar nav, browser back) go through the router and never fire it.
  useBlocker({
    shouldBlockFn: () => {
      if (!dirty) return false
      return !window.confirm(
        '有未保存更改。离开模型页会丢弃这些改动，确认离开？'
      )
    },
    enableBeforeUnload: false,
  })

  const save = useMutation({
    mutationFn: () =>
      api('/api/panel/model-policy', {
        method: 'PUT',
        body: JSON.stringify({ policy: draft, platform: catalogPlatform }),
      }),
    onSuccess: async () => {
      toast.success('模型策略已保存')
      await qc.invalidateQueries({
        queryKey: modelPolicyQueryOptions(catalogPlatform).queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const reset = useMutation({
    mutationFn: () =>
      api('/api/panel/model-policy/reset', {
        method: 'POST',
        body: JSON.stringify({ platform: catalogPlatform }),
      }),
    onSuccess: async () => {
      toast.success('已恢复默认')
      await qc.invalidateQueries({
        queryKey: modelPolicyQueryOptions(catalogPlatform).queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const sync = useMutation({
    mutationFn: () =>
      api<PolicyPayload>('/api/panel/model-policy/sync-worker', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: async (data) => {
      toast.success(`已同步 Worker 目录 (${data.synced || 0})`)
      await qc.invalidateQueries({
        queryKey: modelPolicyQueryOptions('anthropic').queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const syncGpt = useMutation({
    mutationFn: () =>
      api<PolicyPayload>('/api/panel/model-policy/sync-codex', {
        method: 'POST',
        body: '{}',
      }),
    onSuccess: async (data) => {
      toast.success(`已同步 GPT 目录 (${data.synced || 0})`)
      await qc.invalidateQueries({
        queryKey: modelPolicyQueryOptions('openai').queryKey,
      })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  function patchModel(id: string, fn: (rec: Omit<ModelEntry, 'id'>) => void) {
    setDraft((prev) => {
      const next = cloneJson(prev)
      const rec = next.models?.[id]
      if (!rec) return prev
      fn(rec)
      return next
    })
  }

  function setParam(
    id: string,
    key: keyof ModelParams,
    value: string | number
  ) {
    patchModel(id, (rec) => {
      rec.params = rec.params || {}
      if (key === 'on_enabled') {
        rec.params.on_enabled =
          value === 'convert_to_adaptive' ? 'passthrough' : String(value)
        return
      }
      if (key === 'on_adaptive') {
        rec.params.on_adaptive = String(value)
        return
      }
      rec.params[key] = Number(value) || 0
    })
  }

  function batch(action: 'enable' | 'disable' | 'invert') {
    setDraft((prev) => {
      const next = cloneJson(prev)
      for (const rec of Object.values(next.models || {})) {
        if (action === 'enable') rec.enabled = true
        else if (action === 'disable') rec.enabled = false
        else rec.enabled = rec.enabled === false
      }
      return next
    })
  }

  function requestExpand(id: string) {
    if (expanded && expanded !== id && dirty) {
      const ok = window.confirm(
        '有未保存更改。切换模型不会丢草稿，离开页面前请先保存。仍要切换？'
      )
      if (!ok) return
    }
    setExpanded((cur) => (cur === id ? null : id))
  }

  function setPass1m(id: string, mode: Pass1mMode) {
    patchModel(id, (rec) => applyPassContext1m(rec, mode))
  }

  function patchDefaults(patch: Partial<PolicyDefaults>) {
    setDraft((prev) => {
      const next = cloneJson(prev)
      next.defaults = { ...(next.defaults || {}), ...patch }
      return next
    })
  }

  function setCatalog(mode: CatalogMode) {
    setDraft((prev) => {
      const next = cloneJson(prev)
      next.catalog_mode = mode
      return next
    })
  }

  function switchPlatform(next: 'anthropic' | 'openai') {
    if (next === catalogPlatform) return
    if (
      dirty &&
      !window.confirm('有未保存更改。切换号池会丢弃这些改动，确认切换？')
    ) {
      return
    }
    setCatalogPlatform(next)
    setQtext('')
    setFamily('all')
    setBeta('all')
    setExpanded(null)
  }

  const claudePool = catalogPlatform === 'anthropic'
  const poolHint = claudePool
    ? 'Claude 号池。同一会话只占一个 VM session 窗口，不和 GPT 混调度。'
    : 'GPT 号池。粘性独立，不占用 Claude 原生 session 槽。'

  return (
    <PageHeader
      title={VIEW_TITLES.models}
      extra={
        <div className='flex flex-wrap gap-2'>
          {claudePool ? (
            <Button
              variant='outline'
              className='cursor-pointer'
              onClick={() => sync.mutate()}
              disabled={sync.isPending}
            >
              {sync.isPending ? '同步中…' : '同步 Worker'}
            </Button>
          ) : (
            <Button
              variant='outline'
              className='cursor-pointer'
              onClick={() => syncGpt.mutate()}
              disabled={syncGpt.isPending}
            >
              {syncGpt.isPending ? '同步中…' : '同步 GPT'}
            </Button>
          )}
          <Button
            variant='outline'
            className='cursor-pointer'
            onClick={() => {
              if (
                dirty &&
                !window.confirm(
                  '恢复官方默认模型矩阵？自定义开关与参数将丢失。'
                )
              ) {
                return
              }
              reset.mutate()
            }}
            disabled={reset.isPending}
          >
            恢复默认
          </Button>
          <Button
            variant={dirty ? 'default' : 'outline'}
            className='cursor-pointer'
            onClick={() => save.mutate()}
            disabled={save.isPending || !dirty}
          >
            {dirty ? '保存更改' : '已保存'}
          </Button>
        </div>
      }
    >
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={
          <div className='space-y-3'>
            <div className='h-9 w-56 rounded-lg bg-muted' />
            <div className='grid gap-2 sm:grid-cols-4'>
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className='h-16 rounded-lg bg-muted' />
              ))}
            </div>
            <TableSkeleton rows={8} columns={7} />
          </div>
        }
      >
        <div className='mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
          <div className='min-w-0 space-y-2'>
            <Tabs
              value={catalogPlatform}
              onValueChange={(value) => {
                if (value === 'anthropic' || value === 'openai')
                  switchPlatform(value)
              }}
            >
              <TabsList aria-label='模型号池'>
                <TabsTrigger value='anthropic' className='cursor-pointer px-4'>
                  Claude
                </TabsTrigger>
                <TabsTrigger value='openai' className='cursor-pointer px-4'>
                  GPT
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <p className='max-w-xl text-sm text-muted-foreground'>{poolHint}</p>
          </div>
        </div>
        {dirty ? (
          <p
            role='status'
            className='mb-3 flex items-center gap-2 rounded-lg border border-[color:var(--status-caution)]/40 bg-[color:var(--status-caution)]/10 px-3 py-2 text-sm text-foreground'
          >
            <AlertTriangle className='size-4 shrink-0 text-[color:var(--status-caution)]' />
            有未保存更改。离开页面或切换号池前请先保存。
          </p>
        ) : null}
        <div className='mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4'>
          <PoolStat label='配置' value={stats.configured} />
          <PoolStat label='启用' value={stats.enabled} />
          <PoolStat label='对外' value={stats.live} />
          <PoolStat
            label={claudePool ? '1M beta' : '未对外'}
            value={
              claudePool
                ? stats.pass1m
                : all.filter((m) => !effectiveIds.has(m.id)).length
            }
          />
        </div>
        <div className='mb-3 flex flex-col gap-2 rounded-lg border border-border/70 bg-card p-2 sm:flex-row sm:flex-wrap sm:items-center'>
          <Input
            className='w-full sm:w-56'
            type='search'
            placeholder='搜索模型 / 别名…'
            aria-label='搜索模型'
            value={qtext}
            onChange={(e) => setQtext(e.target.value)}
          />
          <div className='flex flex-wrap gap-1.5'>
            {families.map((f) => (
              <Button
                key={f}
                size='sm'
                className='cursor-pointer'
                variant={family === f ? 'default' : 'outline'}
                onClick={() => setFamily(f)}
              >
                {f === 'all' ? '全部' : f}
              </Button>
            ))}
          </div>
          {claudePool ? (
            <div className='flex flex-wrap gap-1.5 sm:border-l sm:border-border/70 sm:pl-2'>
              {BETA_FILTERS.map(([id, lab]) => (
                <Button
                  key={id}
                  size='sm'
                  className='cursor-pointer'
                  variant={beta === id ? 'secondary' : 'ghost'}
                  onClick={() => setBeta(id)}
                >
                  {lab}
                </Button>
              ))}
            </div>
          ) : null}
          <div className='flex flex-wrap gap-1.5 sm:ms-auto'>
            <Button
              size='sm'
              variant='ghost'
              className='cursor-pointer'
              onClick={() => batch('enable')}
            >
              全开
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='cursor-pointer'
              onClick={() => batch('disable')}
            >
              全关
            </Button>
            <Button
              size='sm'
              variant='ghost'
              className='cursor-pointer'
              onClick={() => batch('invert')}
            >
              反选
            </Button>
          </div>
        </div>
        {visible.length === 0 ? (
          <EmptyState
            reason={
              qtext || family !== 'all' || beta !== 'all'
                ? '无匹配模型。改搜索或筛选条件。'
                : claudePool
                  ? '暂无模型配置。可先同步 Worker 目录。'
                  : '暂无 GPT 模型。可先同步 GPT 目录。'
            }
          />
        ) : (
          <div className='overflow-x-auto rounded-lg border border-border/70 bg-card'>
            <div className='min-w-[920px]'>
              <div className='flex h-9 items-center border-b border-border/70 bg-muted/60 text-[11px] font-medium tracking-wide text-muted-foreground'>
                <div className='w-14 shrink-0 pl-3'>启用</div>
                <div className='min-w-[180px] flex-[1.6] px-1.5'>模型</div>
                <div className='min-w-[70px] flex-[0.6] px-1.5'>窗口</div>
                {claudePool ? (
                  <div className='min-w-[140px] flex-[0.9] px-1.5'>
                    官方 1M beta
                  </div>
                ) : null}
                <div className='min-w-[110px] flex-[0.9] px-1.5'>Thinking</div>
                <div className='min-w-[70px] flex-[0.6] px-1.5'>目录</div>
                <div className='w-10 shrink-0 pr-2' />
              </div>
              {visible.map((m) => (
                <ModelRow
                  key={m.id}
                  model={m}
                  live={effectiveIds.has(m.id)}
                  pol={draft}
                  open={expanded === m.id}
                  showBeta={claudePool}
                  onToggleOpen={() => requestExpand(m.id)}
                  onToggleEnabled={(on) =>
                    patchModel(m.id, (rec) => {
                      rec.enabled = on
                    })
                  }
                  onParam={(key, value) => setParam(m.id, key, value)}
                  onPass1m={(mode) => setPass1m(m.id, mode)}
                />
              ))}
            </div>
          </div>
        )}
        <ModelAdvanced
          pol={draft}
          claudePool={claudePool}
          onCatalogMode={setCatalog}
          onDefaults={patchDefaults}
        />
      </QueryGate>
    </PageHeader>
  )
}

function PoolStat({ label, value }: { label: string; value: number }) {
  return (
    <div className='rounded-lg border border-border/70 bg-card px-3 py-2'>
      <div className='text-[11px] font-medium tracking-wide text-muted-foreground'>
        {label}
      </div>
      <div className='mt-0.5 text-lg font-semibold text-foreground tabular-nums'>
        {value}
      </div>
    </div>
  )
}
