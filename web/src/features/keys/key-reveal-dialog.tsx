import { toast } from 'sonner'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type RevealedKey = {
  title: string
  name?: string
  id?: string
  key: string
}

export function KeyRevealDialog({
  value,
  onClose,
}: {
  value: RevealedKey | null
  onClose: () => void
}) {
  const plain = value?.key || ''

  function copy() {
    if (!plain) {
      toast.error('没有可复制的密钥')
      return
    }
    void copyText(plain)
      .then(() => toast.success('已复制明文密钥，请妥善保存'))
      .catch(() => toast.error('复制失败'))
  }

  return (
    <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {value?.title || '密钥'}
            {value?.name ? ` · ${value.name}` : ''}
          </DialogTitle>
        </DialogHeader>
        <p className='text-xs text-muted-foreground'>
          {value?.id ? (
            <span className='font-mono'>{value.id}</span>
          ) : (
            '明文仅在此弹层展示'
          )}
        </p>
        <button
          type='button'
          className='w-full cursor-pointer rounded-md border bg-muted/40 p-3 text-left font-mono text-sm break-all'
          onClick={copy}
        >
          {plain}
        </button>
        <p className='text-sm text-destructive'>
          关闭后列表仍只显示脱敏片段。可还原的密钥之后还能再点「查看」或「复制」。
        </p>
        <DialogFooter>
          <Button variant='outline' onClick={onClose}>
            关闭
          </Button>
          <Button onClick={copy}>复制</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
