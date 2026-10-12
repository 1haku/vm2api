import { Link } from '@tanstack/react-router'
import { DOCS_URL, REPO_URL } from '@/config/repo'
import { ArrowUpRight, BookOpen } from 'lucide-react'
import { IconGithub } from '@/assets/brand-icons'
import { Logo } from '@/assets/logo'
import { Button } from '@/components/ui/button'
import { ThemeSwitch } from '@/components/theme-switch'

export function WelcomeTopBar({
  signedIn,
  username,
  onLogin,
}: {
  signedIn: boolean
  username: string
  onLogin: () => void
}) {
  return (
    <header className='sticky top-0 z-40 border-b border-border/80 bg-background'>
      <div className='mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6'>
        <Link
          to='/welcome'
          className='flex min-w-0 items-center gap-2.5 rounded-md outline-hidden focus-visible:ring-2 focus-visible:ring-ring'
        >
          <span className='grid size-8 shrink-0 place-items-center rounded-lg bg-slate-950 text-white shadow-sm ring-1 ring-cyan-500/35'>
            <Logo aria-hidden className='size-4' />
          </span>
          <span className='truncate text-sm font-semibold tracking-tight'>
            vm2api
          </span>
        </Link>
        <nav
          aria-label='项目链接'
          className='ms-auto flex items-center gap-1 sm:gap-1.5'
        >
          <a
            href={DOCS_URL}
            target='_blank'
            rel='noreferrer'
            className='inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          >
            <BookOpen aria-hidden className='size-4' />
            <span className='hidden sm:inline'>文档</span>
            <ArrowUpRight
              aria-hidden
              className='hidden size-3.5 opacity-60 sm:inline'
            />
          </a>
          <a
            href={REPO_URL}
            target='_blank'
            rel='noreferrer'
            className='inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
          >
            <IconGithub aria-hidden className='size-4' />
            <span className='hidden sm:inline'>GitHub</span>
            <ArrowUpRight
              aria-hidden
              className='hidden size-3.5 opacity-60 sm:inline'
            />
          </a>
          <ThemeSwitch />
          {signedIn ? (
            <div className='flex items-center gap-2 ps-1'>
              <span className='hidden max-w-28 truncate text-sm text-muted-foreground sm:inline'>
                {username}
              </span>
              <Button asChild size='sm'>
                <Link to='/overview'>进入控制台</Link>
              </Button>
            </div>
          ) : (
            <Button size='sm' onClick={onLogin}>
              登录
            </Button>
          )}
        </nav>
      </div>
    </header>
  )
}
