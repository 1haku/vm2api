import type { UsageAccountRow } from '@/types/panel-usage'
import type { Vm } from '@/types/panel-vm'
import {
  expiresAtToMs,
  fmtResetClock,
  resetCountdown,
} from '@/lib/fable-status'
import { fmtNum, usedPctOf } from '@/lib/format'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import {
  formatWindowSpend,
  pickWindowEstimate,
  vmFableCost,
  vmWeekOutcome,
  vmWindowCosts,
} from '@/lib/vm-usage'
import { useNow } from '@/hooks/use-now'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { ClaudeResetActions } from '@/features/vm/claude-reset-actions'
import { OpenaiQuotaActions } from '@/features/vm/openai-quota-actions'
import { fableRow, riskFg, UsageMeter } from '@/features/vm/usage-meter'

/**
 * 统一用量窗口：列表行、网格卡片、详情卡共用同一套六列网格。
 * 标签 | 条 | 百分比 | 已用/估算总量 | 剩余 | 重置倒计时。
 * 行序固定 5h → 7d → Fable：Fable 只在 Max 上出现，缺席时不挪动前两行。
 */
const ROW_GRID =
  'grid grid-cols-[1.6rem_minmax(2rem,1fr)_2rem_6.5rem_3.5rem_3.75rem] items-center gap-x-1'

function WindowRow({
  label,
  value,
  costText,
  remainText,
  reset,
  resetTitle,
  tooltip,
  note,
  quiet,
}: {
  label: string
  value?: number
  costText?: string
  remainText?: string
  reset?: string | null
  resetTitle?: string | null
  tooltip?: string
  /** 无百分比的态（拒 / 满）：用文案替换条与百分比。 */
  note?: string
  /** 卡片是分诊面：绿色数字铺满一屏是噪声，颜色只留给越线的档。 */
  quiet?: boolean
}) {
  const pct = value ?? 0
  const risky = pct >= 70
  const money = (
    <>
      <span className='truncate text-right font-mono text-[11px] text-foreground/70 tabular-nums'>
        {costText || ''}
      </span>
      <span className='truncate text-right font-mono text-[11px] text-muted-foreground tabular-nums'>
        {remainText || ''}
      </span>
    </>
  )
  return (
    <div className={ROW_GRID}>
      <span className='text-xs font-medium text-muted-foreground'>{label}</span>
      {note ? (
        <span className='col-span-2 truncate text-xs font-medium text-[color:var(--status-warn)]'>
          {note}
        </span>
      ) : (
        <>
          <UsageMeter value={pct} size='sm' ticks={false} />
          <span
            className={cn(
              'text-right font-mono text-xs font-medium tabular-nums',
              (!quiet || risky) && riskFg(pct)
            )}
          >
            {pct.toFixed(0)}%
          </span>
        </>
      )}
      {tooltip ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className='col-span-2 grid cursor-default grid-cols-subgrid'>
              {money}
            </span>
          </TooltipTrigger>
          <TooltipContent className='max-w-xs whitespace-pre-line'>
            {tooltip}
          </TooltipContent>
        </Tooltip>
      ) : (
        money
      )}
      <span
        className='text-right font-mono text-[11px] text-muted-foreground tabular-nums'
        title={resetTitle || undefined}
      >
        {reset ?? ''}
      </span>
    </div>
  )
}

export function VmUsageWindows({
  vm,
  accounts,
  quiet = false,
  quotaActions = false,
  className,
}: {
  vm: Vm
  accounts?: UsageAccountRow[]
  quiet?: boolean
  /** GPT 槽在窗口下方追加「查询 / 重置券」；Claude 完整 OAuth 追加原生限额重置。 */
  quotaActions?: boolean
  className?: string
}) {
  const now = useNow()
  const hasToken = Boolean(vm.has_token)
  const codex = isCodexVm(vm)
  const fable = codex ? null : fableRow(vm)
  const costs = vmWindowCosts(vm, accounts)
  const week = vmWeekOutcome(vm, accounts)
  const est5 = pickWindowEstimate(vm, accounts, 'estimate_5h')
  const est7 = pickWindowEstimate(vm, accounts, 'estimate_7d')
  const estFable = pickWindowEstimate(vm, accounts, 'estimate_fable')
  const spend5 = formatWindowSpend(costs.h5, est5)
  const spend7 = formatWindowSpend(costs.d7, est7)
  const spendFable = formatWindowSpend(vmFableCost(vm, accounts), estFable)
  // 无凭证槽没有窗口，倒计时无意义；有票才算。
  const cd = (v: unknown) => (hasToken ? resetCountdown(v, now) : null)
  const clock = (v: unknown) =>
    hasToken && expiresAtToMs(v) ? `重置于 ${fmtResetClock(v)}` : null
  const fiveReq = Number(vm.window_5h_requests) || 0
  const fiveTok = Number(vm.window_5h_tokens) || 0
  const fiveTitle =
    fiveReq > 0 || fiveTok > 0
      ? `5h 窗口 ${fmtNum(fiveReq)} req / ${fmtNum(fiveTok)} tok`
      : undefined
  const weekTitle =
    week.req > 0 || week.tok > 0
      ? `7d 窗口 ${fmtNum(week.req)} req / ${fmtNum(week.tok)} tok`
      : undefined
  return (
    <div className={cn('space-y-1', className)}>
      <WindowRow
        label='5h'
        value={usedPctOf(vm, '5h')}
        costText={spend5.costText}
        remainText={spend5.remainText}
        reset={cd(vm.reset_5h)}
        resetTitle={clock(vm.reset_5h)}
        tooltip={[fiveTitle, spend5.tooltip].filter(Boolean).join('\n')}
        quiet={quiet}
      />
      <WindowRow
        label='7d'
        value={usedPctOf(vm, '7d')}
        costText={spend7.costText}
        remainText={spend7.remainText}
        reset={cd(vm.reset_7d)}
        resetTitle={clock(vm.reset_7d)}
        tooltip={[weekTitle, spend7.tooltip].filter(Boolean).join('\n')}
        quiet={quiet}
      />
      {fable?.kind === 'bar' ? (
        <WindowRow
          label='Fable'
          value={fable.pct}
          costText={spendFable.costText}
          remainText={spendFable.remainText}
          reset={cd(vm.reset_7d_oi)}
          resetTitle={clock(vm.reset_7d_oi)}
          tooltip={spendFable.tooltip}
          quiet={quiet}
        />
      ) : fable?.kind === 'note' ? (
        <WindowRow
          label='Fable'
          note={fable.text}
          costText={spendFable.costText}
          remainText={spendFable.remainText}
          tooltip={spendFable.tooltip}
        />
      ) : null}
      {quotaActions && codex ? (
        <div className='pt-0.5'>
          <OpenaiQuotaActions vm={vm} compact />
        </div>
      ) : null}
      {quotaActions && !codex ? (
        <div className='pt-0.5'>
          <ClaudeResetActions vm={vm} compact now={now} />
        </div>
      ) : null}
    </div>
  )
}
