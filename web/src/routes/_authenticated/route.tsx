import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  redirect,
  useNavigate,
  useLocation,
} from '@tanstack/react-router'
import { canOpenPath } from '@/config/nav'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError } from '@/lib/api'
import { hasSession } from '@/lib/session'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { homePathFor } from '@/components/layout/data/sidebar-data'
import { meQueryOptions } from '@/features/auth/queries'
import { guardPanelRoute } from '@/features/auth/route-guard'
import { FleetActions } from '@/features/fleet/fleet-actions'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ context, location, preload }) => {
    if (!hasSession()) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      })
    }
    await guardPanelRoute({
      queryClient: context.queryClient,
      location,
      preload,
    })
  },
  component: Authenticated,
})

function Authenticated() {
  const navigate = useNavigate()
  const location = useLocation()
  const onKernelPage = location.pathname === '/wrap'
  const meQuery = useQuery(meQueryOptions())
  const setMe = useAuthStore((s) => s.setMe)
  const signOut = useAuthStore((s) => s.signOut)
  const userOutsideHome =
    !!meQuery.data && !canOpenPath(meQuery.data.views, location.pathname)
  useEffect(() => {
    if (meQuery.data) setMe(meQuery.data)
  }, [meQuery.data, setMe])
  useEffect(() => {
    if (userOutsideHome) {
      void navigate({ to: homePathFor(meQuery.data?.views), replace: true })
    }
  }, [userOutsideHome, navigate, meQuery.data?.views])
  useEffect(() => {
    if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
      signOut()
      navigate({
        to: '/login',
        search: { redirect: undefined },
      })
    }
  }, [meQuery.error, signOut, navigate])
  if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
    return null
  }
  if (meQuery.isPending || userOutsideHome) return null
  return (
    <AuthenticatedLayout
      headerActions={
        meQuery.data?.role === 'admin' && !onKernelPage ? (
          <FleetActions />
        ) : null
      }
    />
  )
}
