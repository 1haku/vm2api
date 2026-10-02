import { createFileRoute } from '@tanstack/react-router'
import { UsageRecordsPage } from '@/features/usage-records'

export const Route = createFileRoute('/_authenticated/usage-records')({
  component: UsageRecordsPage,
})
