import { Link } from '@tanstack/react-router'
import { REPO_URL } from '@/config/repo'
import { Menu, X } from 'lucide-react'
import { IconGithub } from '@/assets/brand-icons'
import { Logo } from '@/assets/logo'
import { cn } from '@/lib/utils'
import {
  SidebarMenu,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { Button } from '../ui/button'

const CHIP_CLASS =
  'inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] font-medium text-sidebar-foreground/65 outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-sidebar-ring'

const CHIP_LINK_CLASS =
  'cursor-pointer hover:border-primary/45 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'

export function AppTitle({ version }: { version?: string }) {
  const { setOpenMobile } = useSidebar()
  return (
    <SidebarMenu>
      <SidebarMenuItem className='border-b border-sidebar-border px-2 pt-3 pb-4 group-data-[collapsible=icon]:border-transparent group-data-[collapsible=icon]:p-0'>
        <div className='flex items-center gap-2'>
          <Link
            to='/'
            onClick={() => setOpenMobile(false)}
            aria-label='vm2api 首页'
            className='flex min-w-0 flex-1 items-center gap-2.5 rounded-lg outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring'
          >
            <span className='grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15 group-data-[collapsible=icon]:size-8'>
              <Logo
                aria-hidden
                className='size-5 group-data-[collapsible=icon]:size-4'
              />
            </span>
            <span className='grid min-w-0 leading-tight group-data-[collapsible=icon]:hidden'>
              <span className='truncate text-base font-bold tracking-tight'>
                vm2api
              </span>
              <span className='truncate text-xs text-sidebar-foreground/60'>
                共享订阅控制台
              </span>
            </span>
          </Link>
          <ToggleSidebar className='group-data-[collapsible=icon]:hidden' />
        </div>
        <div className='mt-3 flex items-center gap-1 group-data-[collapsible=icon]:hidden'>
          <VersionChip version={version?.replace(/^v/i, '')} />
          <span className='rounded bg-primary/8 px-1.5 py-0.5 text-[10px] text-primary'>
            订阅定制版
          </span>
          <a
            href={REPO_URL}
            target='_blank'
            rel='noreferrer'
            title='查看上游 GitHub 项目'
            aria-label='查看上游 GitHub 项目'
            className={cn(CHIP_CLASS, CHIP_LINK_CLASS, 'ml-auto')}
          >
            <IconGithub aria-hidden className='size-4 shrink-0' />
          </a>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

function VersionChip({ version }: { version?: string }) {
  if (!version) {
    return (
      <span className={CHIP_CLASS}>
        <span className='size-2 shrink-0 rounded-full bg-sidebar-foreground/30' />
        <span className='truncate font-mono text-sidebar-foreground/60'>
          版本 —
        </span>
      </span>
    )
  }
  return (
    <a
      href={`${REPO_URL}/releases/tag/v${version}`}
      target='_blank'
      rel='noreferrer'
      title={`v${version} 发布说明`}
      className={cn(CHIP_CLASS, CHIP_LINK_CLASS)}
    >
      <span className='truncate font-mono font-semibold tabular-nums'>
        v{version}
      </span>
    </a>
  )
}

function ToggleSidebar({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()
  return (
    <Button
      data-sidebar='trigger'
      data-slot='sidebar-trigger'
      variant='ghost'
      size='icon'
      className={cn(
        'aspect-square size-8 shrink-0 cursor-pointer max-md:scale-125',
        className
      )}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <X className='md:hidden' />
      <Menu className='max-md:hidden' />
      <span className='sr-only'>切换侧栏</span>
    </Button>
  )
}
