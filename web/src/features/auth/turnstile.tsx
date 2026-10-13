import { useEffect, useRef, useState } from 'react'
import { useTheme } from '@/context/theme-provider'
import { Button } from '@/components/ui/button'

type TurnstileAPI = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (id: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileAPI
  }
}
type Config = {
  enabled: boolean
  ready: boolean
  sitekey: string
  hostnames: string[]
}
let scriptLoading: Promise<void> | null = null
function loadScript() {
  if (window.turnstile) return Promise.resolve()
  if (scriptLoading) return scriptLoading
  scriptLoading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src =
      'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    const timeout = window.setTimeout(() => fail(), 15000)
    function fail() {
      clearTimeout(timeout)
      script.remove()
      scriptLoading = null
      reject(new Error('人机验证加载失败，请检查网络后重试'))
    }
    script.onerror = fail
    script.onload = () => {
      clearTimeout(timeout)
      if (!window.turnstile) return fail()
      resolve()
    }
    document.head.appendChild(script)
  })
  return scriptLoading
}

export function LoginVerification({
  attempt,
  onChange,
}: {
  attempt: number
  onChange: (ready: boolean, token: string) => void
}) {
  const { theme } = useTheme()
  const container = useRef<HTMLDivElement>(null)
  const notify = useRef(onChange)
  notify.current = onChange
  const [config, setConfig] = useState<Config | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    const ctrl = new AbortController()
    setError('')
    setLoading(true)
    notify.current(false, '')
    const timeout = setTimeout(() => ctrl.abort(), 10000)
    fetch('/api/panel/login-config', { cache: 'no-store', signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error()
        const c = (await r.json()) as Config
        if (
          typeof c.enabled !== 'boolean' ||
          typeof c.ready !== 'boolean' ||
          !Array.isArray(c.hostnames)
        )
          throw new Error()
        if (ctrl.signal.aborted) return
        setConfig(c)
        if (!c.ready) setError('登录验证暂不可用，请联系管理员')
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setError('无法加载登录验证设置，请重试')
        else if (!disposed) setError('登录验证设置加载超时，请重试')
      })
      .finally(() => {
        clearTimeout(timeout)
        if (!disposed) setLoading(false)
      })
    let disposed = false
    return () => {
      disposed = true
      clearTimeout(timeout)
      ctrl.abort()
    }
  }, [retry])

  const wrongHost =
    !!config?.enabled && config.ready && !config.hostnames.includes(window.location.hostname)
  useEffect(() => {
    let disposed = false
    let widget: string | undefined
    notify.current(false, '')
    if (!config?.ready || loading) return
    if (!config.enabled) {
      notify.current(true, '')
      return
    }
    if (wrongHost || !container.current) return
    setError('')
    loadScript()
      .then(() => {
        if (disposed || !container.current) return
        widget = window.turnstile!.render(container.current, {
          sitekey: config.sitekey,
          action: 'login',
          theme: theme === 'system' ? 'auto' : theme,
          size: 'flexible',
          language: 'zh-CN',
          callback: (token: string) => {
            if (!disposed) {
              setError('')
              notify.current(true, token)
            }
          },
          'expired-callback': () => {
            if (!disposed) {
              notify.current(false, '')
              setError('验证已过期，请重新验证')
            }
          },
          'error-callback': () => {
            if (!disposed) {
              notify.current(false, '')
              setError('人机验证失败，请重试')
            }
          },
          'timeout-callback': () => {
            if (!disposed) {
              notify.current(false, '')
              setError('验证超时，请重试')
            }
          },
        })
      })
      .catch(() => {
        if (!disposed) setError('人机验证加载失败，请检查网络后重试')
      })
    return () => {
      disposed = true
      if (widget !== undefined) window.turnstile?.remove(widget)
    }
  }, [config, loading, wrongHost, theme, attempt])

  if (wrongHost)
    return (
      <p role='alert' className='text-sm text-muted-foreground'>
        请通过{' '}
        <a
          className='underline'
          href={`https://${config!.hostnames[0]}/console/#/login`}
        >
          面板域名
        </a>
        登录以完成人机验证。
      </p>
    )
  return (
    <div
      className={
        config && !config.enabled && !loading && !error ? 'hidden' : 'space-y-2'
      }
    >
      <div ref={container} />
      {loading && (
        <p role='status' className='text-sm text-muted-foreground'>
          正在加载登录验证…
        </p>
      )}
      {error && (
        <div className='text-sm text-destructive' role='alert'>
          {error}{' '}
          <Button
            type='button'
            variant='link'
            className='h-auto p-0'
            onClick={() => {
              setConfig(null)
              setRetry((n) => n + 1)
            }}
          >
            重试
          </Button>
        </div>
      )}
    </div>
  )
}
