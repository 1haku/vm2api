import { createFileRoute } from '@tanstack/react-router'
import { WelcomePage } from '@/features/welcome'

export const Route = createFileRoute('/welcome')({
  validateSearch: (search: Record<string, unknown>) => {
    const login =
      search.login === true || search.login === 'true' || search.login === '1'
    return {
      ...(login ? { login: true as const } : {}),
      ...(typeof search.redirect === 'string' && search.redirect
        ? { redirect: search.redirect }
        : {}),
    }
  },
  component: WelcomePage,
})
