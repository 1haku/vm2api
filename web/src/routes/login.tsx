import { createFileRoute, redirect } from '@tanstack/react-router'
import { hasSession } from '@/lib/session'

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>) => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (hasSession()) throw redirect({ to: '/' })
    throw redirect({
      to: '/welcome',
      search: {
        login: true,
        ...(search.redirect ? { redirect: search.redirect } : {}),
      },
    })
  },
  component: () => null,
})
