import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { loginRequest } from '@/lib/api'
import { apiBase, sameOriginPanel, setApiBase } from '@/lib/session'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { onboardingQueryOptions } from '@/features/welcome/queries'

export function LoginDialog({
  open,
  onOpenChange,
  redirect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  redirect?: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const signIn = useAuthStore((s) => s.signIn)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [base, setBase] = useState(apiBase())
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const hideBase = sameOriginPanel()

  useEffect(() => {
    if (open) setError('')
    else setPassword('')
  }, [open])

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setPending(true)
    try {
      if (hideBase) setApiBase('')
      else setApiBase(base)
      const result = await loginRequest({
        username: username.trim(),
        password,
        base: hideBase ? '' : base.trim().replace(/\/$/, '') || apiBase(),
      })
      signIn(result.token, result.user)
      let needsWelcome = false
      try {
        const onboarding = await queryClient.fetchQuery(
          onboardingQueryOptions(true)
        )
        needsWelcome = Boolean(onboarding.needs_welcome)
      } catch {
        needsWelcome = false
      }
      toast.success('登录成功')
      onOpenChange(false)
      if (needsWelcome) return
      // `redirect` is a router href (`/vm/x?tab=y`); never bounce back into the public pages.
      const next = redirect
      if (
        next &&
        next.startsWith('/') &&
        !next.startsWith('//') &&
        !/^\/(welcome|login)\b/.test(next)
      ) {
        await navigate({ href: next })
        return
      }
      await navigate({ to: '/overview' })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-sm' aria-describedby='login-desc'>
        <DialogHeader>
          <DialogTitle>登录控制台</DialogTitle>
          <DialogDescription id='login-desc'>
            使用面板账号进入号池网关。
          </DialogDescription>
        </DialogHeader>
        <form className='space-y-4' onSubmit={onSubmit}>
          <div className='space-y-2'>
            <Label htmlFor='welcome-username'>用户名</Label>
            <Input
              id='welcome-username'
              autoComplete='username'
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='welcome-password'>密码</Label>
            <Input
              id='welcome-password'
              type='password'
              autoComplete='current-password'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {hideBase ? null : (
            <div className='space-y-2'>
              <Label htmlFor='welcome-api-base'>API Base</Label>
              <Input
                id='welcome-api-base'
                placeholder='http://127.0.0.1:8787'
                value={base}
                onChange={(e) => setBase(e.target.value)}
              />
            </div>
          )}
          {error ? (
            <p className='text-sm text-destructive' role='alert'>
              {error}
            </p>
          ) : null}
          <Button className='w-full' type='submit' disabled={pending}>
            {pending ? '登录中…' : '登录'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
