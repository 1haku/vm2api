/**
 * Public console landing. Layout and palette follow the newapi web/default
 * home page (floating header, gradient hero with API demo, bento features,
 * three steps, CTA); tokens are scoped by `.welcome-theme` so the console
 * keeps its own theme. After sign-in the live setup checklist sits under the hero.
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
import { WelcomeCta, WelcomeFooter } from './cta'
import { WelcomeHero } from './hero'
import { onboardingQueryOptions } from './queries'
import { WelcomeQuickStart } from './quick-start'
import { scrollToSection } from './scroll'
import { WelcomeStats } from './stats'
import { WelcomeTopBar } from './top-bar'

export function WelcomePage() {
  const search = useSearch({ from: '/welcome' })
  const navigate = useNavigate()
  const token = useAuthStore((s) => s.token)
  const username = useAuthStore((s) => s.user)
  const signedIn = Boolean(token)
  const [loginOpen, setLoginOpen] = useState(Boolean(search.login) && !signedIn)
  // Set on a fresh sign-in; consumed once the checklist has data to render.
  const scrollPending = useRef(false)
  const wasSignedIn = useRef(signedIn)

  const onboarding = useQuery(onboardingQueryOptions(signedIn))
  const me = useQuery(meQueryOptions(signedIn))

  useEffect(() => {
    if (search.login && !signedIn) setLoginOpen(true)
  }, [search.login, signedIn])

  useEffect(() => {
    if (!wasSignedIn.current && signedIn) scrollPending.current = true
    wasSignedIn.current = signedIn
  }, [signedIn])

  useEffect(() => {
    if (!scrollPending.current || !onboarding.data) return
    scrollPending.current = false
    scrollToSection('welcome-setup')
  }, [onboarding.data])

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
    <div className='welcome-theme min-h-svh overflow-x-hidden bg-background text-foreground'>
      <WelcomeTopBar
        signedIn={signedIn}
        username={username}
        onLogin={() => setLogin(true)}
      />
      <main>
        <WelcomeHero
          signedIn={signedIn}
          baseUrl={base}
          onLogin={() => setLogin(true)}
        />
        {signedIn && onboarding.data ? (
          <WelcomeChecklist payload={onboarding.data} views={me.data?.views} />
        ) : null}
        <WelcomeStats />
        <WelcomeCapabilities />
        <WelcomeQuickStart />
        <WelcomeClientSnippets baseUrl={base} />
        <WelcomeCta signedIn={signedIn} onLogin={() => setLogin(true)} />
      </main>
      <WelcomeFooter />
      <LoginDialog
        open={loginOpen}
        onOpenChange={setLogin}
        redirect={search.redirect}
      />
    </div>
  )
}
