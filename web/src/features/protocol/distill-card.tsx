import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DistillRules } from '@/types/panel-routing'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SettingRow } from '@/components/setting-row'
import { distillQueryOptions } from '@/features/protocol/queries'

function linesOf(text: string) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function fingerprintsOf(text: string) {
  return text
    .split(/\n---\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function DistillCard() {
  const qc = useQueryClient()
  const q = useQuery(distillQueryOptions())
  const [draft, setDraft] = useState<DistillRules | null>(null)
  const [needlesText, setNeedlesText] = useState('')
  const [patternsText, setPatternsText] = useState('')
  const [fpText, setFpText] = useState('')
  useEffect(() => {
    if (!q.data) return
    setDraft({ ...q.data, skip_zero: q.data.skip_zero !== false })
    setNeedlesText(q.data.needles.join('\n'))
    setPatternsText((q.data.patterns || []).join('\n'))
    setFpText(q.data.fingerprints.join('\n---\n'))
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api<DistillRules>('/api/panel/distill', {
        method: 'PUT',
        body: JSON.stringify({
          ...draft,
          needles: linesOf(needlesText),
          patterns: linesOf(patternsText),
          fingerprints: fingerprintsOf(fpText),
        }),
      }),
    onSuccess: async (data) => {
      toast.success('已保存蒸馏拦截')
      setDraft(data)
      setNeedlesText(data.needles.join('\n'))
      setPatternsText((data.patterns || []).join('\n'))
      setFpText(data.fingerprints.join('\n---\n'))
      await qc.invalidateQueries({ queryKey: distillQueryOptions().queryKey })
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p className='text-sm text-destructive'>{(q.error as Error).message}</p>
    )
  }
  if (!draft) return null

  const dirty =
    JSON.stringify({
      ...draft,
      needles: linesOf(needlesText),
      patterns: linesOf(patternsText),
      fingerprints: fingerprintsOf(fpText),
    }) !== JSON.stringify(q.data)
  const patch = (next: Partial<DistillRules>) => setDraft({ ...draft, ...next })
  const patchError = (next: Partial<DistillRules['error']>) =>
    patch({ error: { ...draft.error, ...next } })
  const patchStructure = (next: Partial<DistillRules['structure']>) =>
    patch({ structure: { ...draft.structure, ...next } })

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between gap-3'>
        <CardTitle>蒸馏拦截</CardTitle>
        <Button
          size='sm'
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? '保存中' : '保存'}
        </Button>
      </CardHeader>
      <CardContent className='divide-y'>
        <SettingRow
          label='拦截蒸馏请求'
          desc='命中后返回下面配置的错误码，默认 403 distill_blocked。不打凭证、不 hop 槽位。OpenAI 平台模型不拦截'
        >
          <Switch
            checked={draft.enabled}
            onCheckedChange={(v) => patch({ enabled: v })}
          />
        </SettingRow>
        <SettingRow
          label='官方 Claude Code 放行'
          desc='官方客户端不拦普通针。收割包装和蒸馏/思维链正则仍然拦截'
        >
          <Switch
            checked={draft.skip_official}
            onCheckedChange={(v) => patch({ skip_official: v })}
          />
        </SettingRow>
        <SettingRow
          label='0 注入放行'
          desc='persona_preset / persona_inject 为 zero 时不拦蒸馏。拒答缓存仍生效'
        >
          <Switch
            checked={draft.skip_zero !== false}
            onCheckedChange={(v) => patch({ skip_zero: v })}
          />
        </SettingRow>
        <SettingRow
          label='无工具才拦结构特征'
          desc='带 tools 的对话不当蒸馏收获'
        >
          <Switch
            checked={draft.structure.require_no_tools}
            onCheckedChange={(v) => patchStructure({ require_no_tools: v })}
          />
        </SettingRow>
        <SettingRow label='单轮才拦结构特征' desc='多轮对话不当蒸馏收获'>
          <Switch
            checked={draft.structure.require_single_turn}
            onCheckedChange={(v) => patchStructure({ require_single_turn: v })}
          />
        </SettingRow>
        <div className='grid gap-3 py-3 sm:grid-cols-2'>
          <div className='space-y-1.5'>
            <Label htmlFor='distill-status'>HTTP 状态</Label>
            <Input
              id='distill-status'
              type='number'
              min={400}
              max={599}
              value={draft.error.status}
              onChange={(e) =>
                patchError({ status: Number(e.target.value) || 403 })
              }
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='distill-code'>错误 code</Label>
            <Input
              id='distill-code'
              value={draft.error.code}
              onChange={(e) => patchError({ code: e.target.value })}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='distill-type'>错误 type</Label>
            <Input
              id='distill-type'
              value={draft.error.type}
              onChange={(e) => patchError({ type: e.target.value })}
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='distill-min-tokens'>结构特征 min max_tokens</Label>
            <Input
              id='distill-min-tokens'
              type='number'
              min={256}
              value={draft.structure.min_max_tokens}
              onChange={(e) =>
                patchStructure({
                  min_max_tokens: Number(e.target.value) || 8192,
                })
              }
            />
          </div>
        </div>
        <div className='space-y-1.5 py-3'>
          <Label htmlFor='distill-message'>返回文案</Label>
          <Input
            id='distill-message'
            value={draft.error.message}
            onChange={(e) => patchError({ message: e.target.value })}
          />
        </div>
        <div className='space-y-1.5 py-3'>
          <Label htmlFor='distill-needles'>拦截模板（每行一条）</Label>
          <p className='text-xs text-muted-foreground'>
            命中即拦。不要写「请分步解答」，会误伤探测题。
          </p>
          <Textarea
            id='distill-needles'
            className='min-h-36 font-mono text-xs'
            value={needlesText}
            onChange={(e) => setNeedlesText(e.target.value)}
          />
        </div>
        <div className='space-y-1.5 py-3'>
          <Label htmlFor='distill-patterns'>硬正则（每行一条）</Label>
          <p className='text-xs text-muted-foreground'>
            蒸馏和提取思维链。官方、0
            注入也拦。删掉内置规则保存后会补回。不要写单独的
            distill，会误伤化学题。
          </p>
          <Textarea
            id='distill-patterns'
            className='min-h-36 font-mono text-xs'
            value={patternsText}
            onChange={(e) => setPatternsText(e.target.value)}
          />
        </div>
        <div className='space-y-1.5 py-3'>
          <Label htmlFor='distill-fingerprints'>
            题目指纹（每题用 --- 分隔）
          </Label>
          <p className='text-xs text-muted-foreground'>
            用户题面包含这段文字就拦，不必等结构特征。
          </p>
          <Textarea
            id='distill-fingerprints'
            className='min-h-48 font-mono text-xs'
            value={fpText}
            onChange={(e) => setFpText(e.target.value)}
          />
        </div>
      </CardContent>
    </Card>
  )
}
