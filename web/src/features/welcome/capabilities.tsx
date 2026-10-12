const PROTOCOLS = [
  { path: '/v1/messages', spec: 'Anthropic Messages' },
  { path: '/v1/chat/completions', spec: 'OpenAI Chat' },
  { path: '/v1/responses', spec: 'OpenAI Responses' },
] as const

export function WelcomeCapabilities() {
  return (
    <section className='mx-auto max-w-6xl px-4 sm:px-6'>
      <h2 className='text-2xl font-semibold tracking-tight'>这台网关做什么</h2>
      <p className='mt-2 max-w-[48rem] text-sm leading-6 text-muted-foreground'>
        不是共享 HTTP 反向代理。槽位、出口、协议和进槽前的拦截是同一条生产路径。
      </p>
      <div className='mt-6 grid gap-px overflow-hidden rounded-xl border bg-border/60 md:grid-cols-3'>
        <article className='bg-card px-5 py-5'>
          <h3 className='text-base font-semibold'>槽位隔离</h3>
          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
            每个 VM / 容器槽位里跑官方客户端进程，不是伪造 HTTP
            指纹。账号、会话和硬件特征互不共用。
          </p>
        </article>
        <article className='bg-card px-5 py-5'>
          <h3 className='text-base font-semibold'>出口代理</h3>
          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
            一槽一口。SOCKS5、出口池或本机 px-local，绑不上出口就不能上线。
          </p>
        </article>
        <article className='bg-card px-5 py-5'>
          <h3 className='text-base font-semibold'>风控与统计</h3>
          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
            进槽前过风险审计；用量对齐官方 5h / 7d
            窗口，日志里能看到每一次调度。
          </p>
        </article>
        <article className='bg-card px-5 py-6 md:col-span-3 md:px-6'>
          <h3 className='text-base font-semibold'>协议兼容</h3>
          <p className='mt-2 text-sm leading-6 text-muted-foreground'>
            入站清洗后交给槽内官方进程。客户端仍走这三条标准入口。
          </p>
          <ul className='mt-4 grid gap-2 sm:grid-cols-3'>
            {PROTOCOLS.map((item) => (
              <li
                key={item.path}
                className='rounded-lg border bg-background px-3 py-2.5'
              >
                <code className='block font-mono text-[13px] tracking-tight'>
                  {item.path}
                </code>
                <span className='mt-0.5 block text-xs text-muted-foreground'>
                  {item.spec}
                </span>
              </li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  )
}
