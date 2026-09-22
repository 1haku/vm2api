import { Columns3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  HIDEABLE_LOG_COLUMNS,
  type HideableLogColumn,
} from './column-visibility'

export function ColumnVisibilityMenu({
  hidden,
  onToggle,
}: {
  hidden: readonly HideableLogColumn[]
  onToggle: (id: HideableLogColumn) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant='outline'
          size='sm'
          className='h-8 gap-1.5 text-xs'
          aria-label='列显隐'
        >
          <Columns3 className='size-3.5' />
          列
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-40'>
        <DropdownMenuLabel>显示列</DropdownMenuLabel>
        {HIDEABLE_LOG_COLUMNS.map((col) => (
          <DropdownMenuCheckboxItem
            key={col.id}
            checked={!hidden.includes(col.id)}
            onCheckedChange={() => onToggle(col.id)}
            onSelect={(event) => event.preventDefault()}
          >
            {col.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
