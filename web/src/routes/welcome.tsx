import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasSession } from '@/lib/session'

export const Route = createFileRoute('/welcome')({
  validateSearch: (search: Record<string, unknown>) =>
    [true, 1, '1', 'true'].includes(search.setup as never)
      ? { setup: true as const }
      : {},
  beforeLoad: () => {
    throw redirect({ to: hasSession() ? '/' : '/login' })
  },
})
