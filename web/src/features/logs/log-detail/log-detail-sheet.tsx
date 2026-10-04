import { useEffect, useState } from 'react'
import type { UsageLogRow } from '@/types/panel-usage-logs'
import { FileText, Gauge, GitBranch } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { DetailTab } from '../virtualized-logs-table'
import { LogicTraceTab } from './logic-trace-tab'
import { PerformanceTab } from './performance-tab'
import { SummaryTab } from './summary-tab'

export type DetailState = {
  row: UsageLogRow
  tab?: DetailTab
  chainIndex?: number
  scrollToRedirect?: boolean
}

const TAB_TRIGGER =
  'flex items-center gap-1.5 px-2 py-1.5 text-xs data-[state=active]:bg-background sm:text-sm'
const TAB_ICON = 'h-3.5 w-3.5 shrink-0 sm:h-4 sm:w-4'

/** 请求详情抽屉（hub `ErrorDetailsDialog`）：概览 / 决策链 / 性能。 */
export function LogDetailSheet({
  state,
  onClose,
}: {
  state: DetailState | null
  onClose: () => void
}) {
  const [tab, setTab] = useState<DetailTab>('summary')
  useEffect(() => {
    if (!state) return
    setTab(state.scrollToRedirect ? 'summary' : (state.tab ?? 'summary'))
  }, [state])
  const row = state?.row

  return (
    <Sheet open={!!state} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side='right'
        className='w-[95vw] overflow-y-auto px-4 sm:w-[480px] sm:max-w-none sm:px-6 md:w-[540px] lg:w-[600px] xl:w-[640px]'
      >
        <SheetHeader className='px-0 pb-2'>
          <SheetTitle className='flex items-center gap-2'>请求详情</SheetTitle>
          <SheetDescription className='font-mono text-xs break-all'>
            {row?.requestId || row?.id || '—'}
          </SheetDescription>
        </SheetHeader>
        {row ? (
          <div className='pb-8'>
            <Tabs
              key={row.id}
              value={tab}
              onValueChange={(value) => setTab(value as DetailTab)}
              className='w-full'
            >
              <TabsList className='grid h-auto w-full grid-cols-3 p-1'>
                <TabsTrigger value='summary' className={TAB_TRIGGER}>
                  <FileText className={TAB_ICON} />
                  <span className='hidden sm:inline'>概览</span>
                </TabsTrigger>
                <TabsTrigger value='logic-trace' className={TAB_TRIGGER}>
                  <GitBranch className={TAB_ICON} />
                  <span className='hidden sm:inline'>决策链</span>
                </TabsTrigger>
                <TabsTrigger value='performance' className={TAB_TRIGGER}>
                  <Gauge className={TAB_ICON} />
                  <span className='hidden sm:inline'>性能</span>
                </TabsTrigger>
              </TabsList>
              <TabsContent value='summary' className='mt-4'>
                <SummaryTab
                  row={row}
                  scrollToRedirect={!!state?.scrollToRedirect}
                />
              </TabsContent>
              <TabsContent value='logic-trace' className='mt-4'>
                <LogicTraceTab
                  row={row}
                  initialExpandedIndex={state?.chainIndex}
                />
              </TabsContent>
              <TabsContent value='performance' className='mt-4'>
                <PerformanceTab row={row} />
              </TabsContent>
            </Tabs>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
