import type { ReactNode } from 'react'
import { ConfigDrawer } from '@/components/config-drawer'
import { Header } from '@/components/layout/header'
import { ProfileDropdown } from '@/components/profile-dropdown'
import { Search } from '@/components/search'
import { ThemeSwitch } from '@/components/theme-switch'

type AppHeaderProps = {
  actions?: ReactNode
}

export function AppHeader({ actions }: AppHeaderProps) {
  return (
    <Header fixed>
      <Search
        placeholder='搜索页面…'
        className='max-sm:w-8 max-sm:flex-none max-sm:border-0 max-sm:bg-transparent max-sm:p-0 max-sm:[&_.search-label]:hidden'
      />
      <div className='ms-auto flex shrink-0 items-center gap-1 sm:gap-2'>
        {actions}
        <ConfigDrawer />
        <ThemeSwitch />
        <ProfileDropdown />
      </div>
    </Header>
  )
}
