import { createFileRoute } from '@tanstack/react-router'
import { WelcomePage } from '@/features/welcome'

export const Route = createFileRoute('/welcome')({
  validateSearch: (search: Record<string, unknown>) =>
    search.setup === true || search.setup === 1 || search.setup === '1'
      ? { setup: true as const }
      : {},
  component: WelcomePage,
})
