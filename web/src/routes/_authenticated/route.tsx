import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createFileRoute,
  redirect,
  useNavigate,
  useLocation,
} from '@tanstack/react-router'
import { useAuthStore } from '@/stores/auth-store'
import { ApiError } from '@/lib/api'
import { hasSession } from '@/lib/session'
import { AuthenticatedLayout } from '@/components/layout/authenticated-layout'
import { meQueryOptions } from '@/features/auth/queries'
import { FleetActions } from '@/features/fleet/fleet-actions'

export const Route = createFileRoute('/_authenticated')({
  beforeLoad: async ({ location, context }) => {
    if (!hasSession()) {
      throw redirect({
        to: '/login',
        search: { redirect: location.href },
      })
    }
    const me = await context.queryClient.ensureQueryData(meQueryOptions())
    if (
      me.role === 'user' &&
      !/^\/(subscriptions|usage-records|keys)(\/|$)/.test(location.pathname)
    ) {
      throw redirect({ to: '/subscriptions' })
    }
  },
  component: Authenticated,
})

function Authenticated() {
  const navigate = useNavigate()
  const location = useLocation()
  const meQuery = useQuery(meQueryOptions())
  const setMe = useAuthStore((s) => s.setMe)
  const signOut = useAuthStore((s) => s.signOut)
  const userOutsideHome =
    meQuery.data?.role === 'user' &&
    !/^\/(subscriptions|usage-records|keys)(\/|$)/.test(location.pathname)
  useEffect(() => {
    if (meQuery.data) setMe(meQuery.data)
  }, [meQuery.data, setMe])
  useEffect(() => {
    if (userOutsideHome) {
      void navigate({ to: '/subscriptions' })
    }
  }, [userOutsideHome, navigate])
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
        meQuery.data?.role === 'admin' ? <FleetActions /> : undefined
      }
    />
  )
}
