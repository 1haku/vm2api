import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ConfirmDialog } from '@/components/confirm-dialog'

interface SignOutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SignOutDialog({ open, onOpenChange }: SignOutDialogProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const signOut = useAuthStore((s) => s.signOut)

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title='退出登录'
      desc='退出后需要重新登录才能管理号池。'
      confirmText='退出'
      cancelBtnText='取消'
      destructive
      handleConfirm={async () => {
        await queryClient.cancelQueries()
        queryClient.clear()
        signOut()
        navigate({
          to: '/login',
          search: { redirect: undefined },
          replace: true,
        })
      }}
      className='sm:max-w-sm'
    />
  )
}
