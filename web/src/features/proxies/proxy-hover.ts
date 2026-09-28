import { useSyncExternalStore } from 'react'

/**
 * 左侧席位图与右侧列表共享的悬停目标。
 *
 * 不放页面 state：指针划过时每秒能变十几次，页面 state 会让整张列表跟着重渲。
 * 外部 store + 布尔 selector 只唤醒「命中状态真正翻转」的那一列 / 那一行。
 */
export type ProxyHover = {
  get: () => string
  set: (id: string) => void
  subscribe: (fn: () => void) => () => void
}

export function createProxyHover(): ProxyHover {
  let current = ''
  const subs = new Set<() => void>()
  return {
    get: () => current,
    set: (id) => {
      if (id === current) return
      current = id
      subs.forEach((fn) => fn())
    },
    subscribe: (fn) => {
      subs.add(fn)
      return () => {
        subs.delete(fn)
      }
    },
  }
}

export function useProxyHovered(hover: ProxyHover, id: string): boolean {
  return useSyncExternalStore(hover.subscribe, () => hover.get() === id)
}

export function useProxyHoverId(hover: ProxyHover): string {
  return useSyncExternalStore(hover.subscribe, hover.get)
}
