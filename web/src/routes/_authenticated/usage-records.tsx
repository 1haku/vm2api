import { createFileRoute } from '@tanstack/react-router'
import { UsageRecordsPage } from '@/features/usage-records'
import { parseUsageSearch } from '@/features/usage-records/filters'

export const Route = createFileRoute('/_authenticated/usage-records')({
  validateSearch: parseUsageSearch,
  component: UsageRecordsPage,
})
