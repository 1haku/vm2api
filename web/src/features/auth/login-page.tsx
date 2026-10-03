import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Logo } from '@/assets/logo'
import { useAuthStore } from '@/stores/auth-store'
import { loginRequest } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'
import { ThemeSwitch } from '@/components/theme-switch'

export function LoginPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const search = useSearch({ from: '/login' })
  const signIn = useAuthStore((s) => s.signIn)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setPending(true)
    try {
      const result = await loginRequest({
        username: username.trim(),
        password,
      })
      await queryClient.cancelQueries()
      queryClient.clear()
      signIn(result.token, result.user)
      toast.success('登录成功')
      const next = search.redirect
      if (next && next.startsWith('#/')) {
        window.location.hash = next.replace(/^#/, '')
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
    <main className='flex min-h-svh items-center justify-center bg-muted/25 p-4 sm:p-6'>
      <section
        aria-labelledby='login-title'
        className='relative w-full max-w-[420px] rounded-2xl border bg-card p-6 shadow-sm sm:p-8'
      >
        <div className='absolute top-4 right-4'>
          <ThemeSwitch />
        </div>
        <div className='mb-7'>
          <div className='mb-5 flex items-center gap-2.5'>
            <span className='grid size-9 place-items-center rounded-lg bg-primary/10 text-primary'>
              <Logo className='size-5' />
            </span>
            <span className='text-lg font-semibold tracking-tight'>vm2api</span>
          </div>
          <h1 id='login-title' className='text-xl font-semibold'>
            登录控制台
          </h1>
        </div>
        <form className='space-y-5' onSubmit={onSubmit}>
          <div className='space-y-2'>
            <Label htmlFor='username'>用户名</Label>
            <Input
              id='username'
              className='h-11 bg-background'
              placeholder='请输入用户名'
              required
              autoComplete='username'
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className='space-y-2'>
            <Label htmlFor='password'>密码</Label>
            <PasswordInput
              id='password'
              className='bg-background [&_input]:h-11'
              placeholder='请输入密码'
              required
              autoComplete='current-password'
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error ? (
            <p
              role='alert'
              className='rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive'
            >
              {error}
            </p>
          ) : null}
          <Button
            className='h-11 w-full'
            type='submit'
            disabled={pending || !username.trim() || !password}
            loading={pending}
          >
            {pending ? '登录中…' : '登录'}
          </Button>
        </form>
        <p className='mt-6 text-xs leading-5 text-muted-foreground'>
          开通账号或重置密码，请联系管理员。
        </p>
      </section>
    </main>
  )
}
