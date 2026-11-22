import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError, loginRequest, loginTotpRequest } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { PasswordInput } from '@/components/password-input'
import { ThemeSwitch } from '@/components/theme-switch'
import { usableRedirect } from './sign-in-destination'
import { LoginVerification } from './turnstile'

const OTP_SLOTS = [0, 1, 2, 3, 4, 5]

export function LoginPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const search = useSearch({ from: '/login' })
  const signIn = useAuthStore((s) => s.signIn)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [verification, setVerification] = useState({ ready: false, token: '' })
  const [attempt, setAttempt] = useState(0)
  const [challenge, setChallenge] = useState('')
  const [code, setCode] = useState('')
  const [recoveryMode, setRecoveryMode] = useState(false)

  async function completeSignIn(result: { token: string; user: string }) {
    await queryClient.cancelQueries()
    queryClient.clear()
    signIn(result.token, result.user)
    toast.success('登录成功')
    const next = usableRedirect(search.redirect?.replace(/^#/, ''))
    if (next && !next.includes('\\')) {
      await navigate({ href: next })
      return
    }
    await navigate({ to: '/overview' })
  }

  function resetVerification() {
    setVerification({ ready: false, token: '' })
    setAttempt((n) => n + 1)
  }

  function backToPassword() {
    setChallenge('')
    setCode('')
    setRecoveryMode(false)
    setError('')
    resetVerification()
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault()
    const entered = code.trim()
    if (pending || !entered || (!recoveryMode && !/^\d{6}$/.test(entered)))
      return
    setPending(true)
    setError('')
    try {
      await completeSignIn(
        await loginTotpRequest({
          challenge,
          code: entered,
          username: username.trim(),
        })
      )
    } catch (err) {
      if (
        err instanceof ApiError &&
        [
          'totp_challenge_expired',
          'totp_challenge_invalid',
          'totp_not_enabled',
        ].includes(err.code)
      ) {
        backToPassword()
      }
      setCode('')
      setError(err instanceof Error ? err.message : '验证失败')
    } finally {
      setPending(false)
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (pending || !verification.ready) return
    setError('')
    setPending(true)
    try {
      const result = await loginRequest({
        username: username.trim(),
        password,
        turnstileToken: verification.token || undefined,
      })
      if (result.kind === 'totp') {
        setPassword('')
        setChallenge(result.challenge)
        resetVerification()
      } else {
        await completeSignIn(result)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
      resetVerification()
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
          <h1 id='login-title' className='pe-12 text-xl font-semibold'>
            {challenge ? '两步验证' : '登录控制台'}
          </h1>
        </div>
        {challenge ? (
          <form className='space-y-5' onSubmit={submitCode}>
            <div className='space-y-2'>
              <Label htmlFor='login-totp'>
                {recoveryMode ? '恢复码' : '验证器验证码'}
              </Label>
              {recoveryMode ? (
                <Input
                  id='login-totp'
                  autoFocus
                  autoComplete='one-time-code'
                  placeholder='XXXXX-XXXXX'
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                />
              ) : (
                <InputOTP
                  id='login-totp'
                  maxLength={6}
                  autoFocus
                  inputMode='numeric'
                  value={code}
                  onChange={setCode}
                >
                  <InputOTPGroup>
                    {OTP_SLOTS.map((index) => (
                      <InputOTPSlot key={index} index={index} />
                    ))}
                  </InputOTPGroup>
                </InputOTP>
              )}
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
              loading={pending}
              disabled={
                pending || !code.trim() || (!recoveryMode && code.length !== 6)
              }
            >
              {pending ? '验证中…' : '验证并登录'}
            </Button>
            <div className='flex items-center justify-between'>
              <Button
                type='button'
                variant='link'
                className='px-0'
                disabled={pending}
                onClick={() => {
                  setRecoveryMode(!recoveryMode)
                  setCode('')
                  setError('')
                }}
              >
                {recoveryMode ? '使用验证器验证码' : '使用恢复码'}
              </Button>
              <Button
                type='button'
                variant='link'
                className='px-0'
                onClick={backToPassword}
                disabled={pending}
              >
                返回登录
              </Button>
            </div>
          </form>
        ) : (
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
            <LoginVerification
              attempt={attempt}
              onChange={(ready, token) => setVerification({ ready, token })}
            />
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
              disabled={
                pending || !verification.ready || !username.trim() || !password
              }
              loading={pending}
            >
              {pending ? '登录中…' : '登录'}
            </Button>
          </form>
        )}
      </section>
    </main>
  )
}
