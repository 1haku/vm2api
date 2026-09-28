import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * 代理页的分区容器。只用描边做层级（不叠阴影），和舰队脉搏同一套语言：
 * 页面上的卡片都是「一块工作面」，不是浮起来的装饰。
 */
export function ProxyPanel({
  title,
  meta,
  className,
  children,
}: {
  title: string
  meta?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className={cn('rounded-xl border bg-card p-4', className)}
    >
      <div className='mb-3 flex items-center justify-between gap-2'>
        <h3 id={id} className='text-sm font-semibold tracking-[-0.01em]'>
          {title}
        </h3>
        {meta}
      </div>
      {children}
    </section>
  )
}
