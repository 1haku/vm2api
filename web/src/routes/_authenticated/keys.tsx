import { createFileRoute } from '@tanstack/react-router'
import { KeysPage } from '@/features/keys'
import { parseUsageSearch } from '@/features/usage-records/filters'

export const Route = createFileRoute('/_authenticated/keys')({
  validateSearch: parseUsageSearch,
  component: KeysPage,
})
