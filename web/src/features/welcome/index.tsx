/**
 * THESIS: First-install landing that proves the gateway, then walks an
 * operator from login to a copied client snippet.
 * OWN-WORLD: Panel tokens, dark-first teal, Inter, shadcn. Public chrome.
 * FIRST VIEWPORT: One sentence — 订阅号池 → 兼容 API — plus 登录 / 文档.
 * SIGNATURE: Live checklist after sign-in, copyable Claude / Codex / curl.
 * REFUSES: SaaS kicker, gradient title, fake metrics, auto-playing terminal.
 */
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { LoginDialog } from '@/features/auth/login-dialog'
import { meQueryOptions } from '@/features/auth/queries'
import { WelcomeCapabilities } from './capabilities'
import { WelcomeChecklist } from './checklist'
import { WelcomeClientSnippets } from './client-snippets'
import { WelcomeHero } from './hero'
import { onboardingQueryOptions } from './queries'
import { WelcomeQuickStart } from './quick-start'
import { WelcomeTopBar } from './top-bar'

export function WelcomePage() {
  const search = useSearch({ from: '/welcome' })
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const username = useAuthStore((s) => s.user)
  const signedIn = Boolean(token)
  const [loginOpen, setLoginOpen] = useState(Boolean(search.login) && !signedIn)
  const wasSignedIn = useRef(signedIn)

  const onboarding = useQuery(onboardingQueryOptions(signedIn))
  const me = useQuery(meQueryOptions(signedIn))

  useEffect(() => {
    if (search.login && !signedIn) setLoginOpen(true)
  }, [search.login, signedIn])

  useEffect(() => {
    if (!wasSignedIn.current && signedIn) {
      const reduce = window.matchMedia(
        '(prefers-reduced-motion: reduce)'
      ).matches
      document.getElementById('welcome-setup')?.scrollIntoView({
        behavior: reduce ? 'auto' : 'smooth',
        block: 'start',
      })
    }
    wasSignedIn.current = signedIn
  }, [signedIn])

  function setLogin(open: boolean) {
    setLoginOpen(open)
    if (!open && search.login) {
      void navigate({
        to: '/welcome',
        search: { redirect: search.redirect },
        replace: true,
      })
    }
  }

  const base =
    (onboarding.data?.base_url || '').replace(/\/$/, '') || location.origin

  return (
    <div className='min-h-svh bg-background text-foreground'>
      <WelcomeTopBar
        signedIn={signedIn}
        username={username}
        onLogin={() => setLogin(true)}
      />
      <main>
        <WelcomeHero signedIn={signedIn} onLogin={() => setLogin(true)} />
        <div className='flex flex-col gap-16 pb-20 sm:gap-20'>
          {signedIn && onboarding.data ? (
            <WelcomeChecklist
              payload={onboarding.data}
              views={me.data?.views}
            />
          ) : null}
          <WelcomeCapabilities />
          <WelcomeQuickStart />
          <WelcomeClientSnippets baseUrl={base} />
        </div>
      </main>
      <LoginDialog
        open={loginOpen}
        onOpenChange={setLogin}
        redirect={search.redirect}
      />
    </div>
  )
}
