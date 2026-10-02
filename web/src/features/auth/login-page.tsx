import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  ArrowRight,
  Layers3,
  ShieldCheck,
  Users,
  Activity,
  KeyRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { Logo } from '@/assets/logo'
import { useAuthStore } from '@/stores/auth-store'
import { loginRequest } from '@/lib/api'
import { apiBase, sameOriginPanel, setApiBase } from '@/lib/session'
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
  const [base, setBase] = useState(apiBase())
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const hideBase = sameOriginPanel()

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
    <div className='login-shell min-h-svh bg-background p-4 sm:p-8 lg:p-10'>
      <div className='mx-auto flex min-h-[calc(100svh-2rem)] max-w-[1440px] flex-col overflow-hidden rounded-3xl border bg-card shadow-sm sm:min-h-[calc(100svh-4rem)] lg:min-h-[calc(100svh-5rem)] lg:flex-row'>
        <section className='login-story relative flex flex-col justify-between overflow-hidden bg-[#102e2b] p-6 text-white sm:p-10 lg:w-[52%] lg:p-14'>
          <div className='relative z-10 flex items-center gap-3'>
            <span className='grid size-11 place-items-center rounded-xl border border-white/20 bg-white/10'>
              <Logo className='size-6' />
            </span>
            <div>
              <p className='text-xl font-semibold tracking-tight'>vm2api</p>
              <p className='mt-0.5 text-xs tracking-widest text-emerald-100/60'>
                共享订阅控制台
              </p>
            </div>
          </div>
          <div className='relative z-10 pt-5 sm:py-10 lg:py-16'>
            <p className='mb-5 hidden text-xs font-medium tracking-[0.25em] text-emerald-200/70 sm:block'>
              ONE WORKSPACE. EVERY REQUEST.
            </p>
            <h1 className='text-xl leading-[1.4] font-semibold tracking-tight sm:text-4xl lg:text-[2.75rem]'>
              连接你的模型，
              <br />
              掌握每一次使用。
            </h1>
            <p className='mt-5 hidden max-w-sm text-sm leading-7 text-emerald-50/65 sm:block'>
              从订阅分配到密钥接入，让资源管理更清晰，让每一笔用量都有迹可循。
            </p>
            <div
              className='mt-10 hidden rounded-2xl border border-white/15 bg-white/5 p-6 lg:block'
              aria-label='订阅分配流程'
            >
              <div className='flex items-center justify-between text-sm'>
                {[
                  [Layers3, '账号槽位'],
                  [ShieldCheck, '共享订阅'],
                  [Users, '多个用户'],
                ].map(([Icon, label], i) => {
                  const StepIcon = Icon as typeof Layers3
                  return (
                    <div
                      key={String(label)}
                      className='flex items-center gap-4'
                    >
                      <div className='flex flex-col items-center gap-3'>
                        <span className='grid size-12 place-items-center rounded-xl border border-emerald-100/15 bg-emerald-100/10'>
                          <StepIcon className='size-5 text-emerald-200' />
                        </span>
                        <span className='text-xs text-emerald-50/80'>
                          {String(label)}
                        </span>
                      </div>
                      {i < 2 && (
                        <ArrowRight className='mb-7 size-4 text-emerald-100/40' />
                      )}
                    </div>
                  )
                })}
              </div>
              <div className='mt-6 border-t border-white/10 pt-4 text-xs leading-6 text-emerald-100/60'>
                集中分配资源 · 每人独立额度 · 按密钥追踪用量
              </div>
            </div>
          </div>
          <div className='relative z-10 hidden items-center gap-6 text-xs text-emerald-50/60 sm:flex'>
            <span className='flex items-center gap-2'>
              <KeyRound className='size-4' />
              独立密钥
            </span>
            <span className='flex items-center gap-2'>
              <Activity className='size-4' />
              用量明细
            </span>
            <span className='flex items-center gap-2'>
              <ShieldCheck className='size-4' />
              权限隔离
            </span>
          </div>
        </section>
        <section className='relative flex flex-1 items-center justify-center p-7 sm:p-12 lg:p-16'>
          <div className='absolute top-4 right-4'>
            <ThemeSwitch />
          </div>
          <div className='w-full max-w-[360px] py-4 sm:py-8'>
            <p className='mb-3 text-xs font-medium tracking-widest text-primary'>
              欢迎回来
            </p>
            <h2 className='text-3xl font-semibold tracking-tight'>
              登录控制台
            </h2>
            <p className='mt-3 mb-9 text-sm leading-6 text-muted-foreground'>
              使用你的账号，继续管理订阅与用量。
            </p>
            <form className='space-y-5' onSubmit={onSubmit}>
              <div className='space-y-2'>
                <Label htmlFor='username'>用户名</Label>
                <Input
                  id='username'
                  className='h-12 bg-background'
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
                  className='bg-background [&_input]:h-12'
                  placeholder='请输入密码'
                  required
                  autoComplete='current-password'
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {hideBase ? null : (
                <details
                  className='rounded-lg border px-3 py-2.5 text-sm'
                  open={Boolean(base) || undefined}
                >
                  <summary className='cursor-pointer text-muted-foreground'>
                    连接设置
                  </summary>
                  <div className='mt-3 space-y-2'>
                    <Label htmlFor='api-base'>服务地址</Label>
                    <Input
                      id='api-base'
                      placeholder={window.location.origin}
                      value={base}
                      onChange={(e) => setBase(e.target.value)}
                    />
                    <p className='text-xs leading-5 text-muted-foreground'>
                      留空使用当前站点。仅连接其他服务时填写。
                    </p>
                  </div>
                </details>
              )}
              {error ? (
                <p
                  role='alert'
                  className='rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive'
                >
                  {error}
                </p>
              ) : null}
              <Button
                className='h-12 w-full justify-between px-5'
                type='submit'
                disabled={pending || !username.trim() || !password}
                loading={pending}
              >
                {pending ? '登录中…' : '登录'}
                {!pending && <ArrowRight className='size-4' />}
              </Button>
            </form>
            <p className='mt-8 border-t pt-6 text-xs leading-6 text-muted-foreground'>
              账号由管理员分配。如需开通账号或重置密码，请联系管理员。
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
