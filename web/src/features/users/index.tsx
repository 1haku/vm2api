import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { VIEW_TITLES } from '@/config/nav'
import type { PanelRole } from '@/types/panel-auth'
import type { PanelUser } from '@/types/panel-users'
import { KeyRound, Pencil, Plus, Trash2, MoreHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@/stores/auth-store'
import { api } from '@/lib/api'
import { fmtUsd } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { TableSkeleton } from '@/components/page-skeletons'
import { PasswordInput } from '@/components/password-input'
import { QueryGate } from '@/components/query-gate'
import { StatCard } from '@/components/stat-card'
import { overviewQuery } from '@/features/subscriptions/admin-overview'
import { SubscriptionWizard } from '@/features/subscriptions/wizard'
import { usersQueryOptions } from '@/features/users/queries'
import { UserSubscriptionDetail } from './subscription-detail'

// Mirrors assertPassword() in src/lib/admin/panel-users.mjs.
const PASSWORD_MIN = 8
const PASSWORD_MAX = 128

const ROLE_LABELS: Record<PanelRole, string> = {
  admin: '管理员',
  super: '运维',
  user: '普通用户',
}

function passwordError(pass: string, confirm: string): string {
  if (!pass) return ''
  if (pass.length < PASSWORD_MIN) return `密码至少 ${PASSWORD_MIN} 位`
  if (pass.length > PASSWORD_MAX) return `密码最多 ${PASSWORD_MAX} 位`
  if (confirm && pass !== confirm) return '两次输入的密码不一致'
  return ''
}

export function UsersPage() {
  const [assignUser, setAssignUser] = useState<string | null>(null)
  const qc = useQueryClient()
  const me = useAuthStore((s) => s.me)
  const q = useQuery(usersQueryOptions())
  const overview = useQuery(overviewQuery())
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [detail, setDetail] = useState<PanelUser | null>(null)
  const allUsers = q.data?.items || []
  const items = allUsers.filter(
    (u) =>
      u.username.toLowerCase().includes(search.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'disabled' ? u.enabled === false : u.role === filter))
  )
  const summary = overview.error ? undefined : overview.data
  const active =
    summary?.subscriptions.filter(
      (s) => s.status === 'active' && s.plan_status === 'active'
    ) || []
  const expiring = active.filter(
    (s) => Date.parse(s.expires_at) <= Date.now() + 7 * 86400000
  )
  const [createOpen, setCreateOpen] = useState(false)
  const [edit, setEdit] = useState<PanelUser | null>(null)
  const [pwTarget, setPwTarget] = useState<PanelUser | null>(null)
  const [del, setDel] = useState<PanelUser | null>(null)
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: usersQueryOptions().queryKey }),
      qc.invalidateQueries({ queryKey: ['subscription-overview'] }),
    ])

  return (
    <PageHeader
      title={VIEW_TITLES.users}
      extra={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus />
          新建用户
        </Button>
      }
    >
      <p className='mb-5 text-sm text-muted-foreground'>
        集中管理用户订阅、个人额度和用量。今日数据按上海时区统计。
      </p>
      <div className='mb-5 grid gap-3 sm:grid-cols-3'>
        <StatCard label='用户总数' value={String(allUsers.length)} />
        <StatCard
          label='生效订阅'
          value={summary ? String(active.length) : '—'}
        />
        <StatCard
          label='7 天内到期'
          value={summary ? String(expiring.length) : '—'}
          tone={expiring.length ? 'caution' : 'neutral'}
        />
      </div>
      <div className='mb-4 flex flex-wrap gap-3'>
        <Input
          aria-label='搜索用户'
          placeholder='搜索用户名'
          className='max-w-sm'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label='筛选用户'
          className='h-9 rounded-md border bg-background px-3 text-sm'
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value='all'>全部用户</option>
          <option value='user'>普通用户</option>
          <option value='admin'>管理员</option>
          <option value='super'>运维</option>
          <option value='disabled'>已停用</option>
        </select>
        <Button variant='outline' onClick={() => void refresh()}>
          刷新
        </Button>
      </div>
      {overview.error && (
        <p role='alert' className='mb-4 text-sm text-destructive'>
          订阅汇总加载失败：{overview.error.message}
        </p>
      )}
      <QueryGate
        loading={q.isLoading}
        error={q.error}
        skeleton={<TableSkeleton rows={8} columns={6} />}
      >
        <div className='overflow-x-auto rounded-md border'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>用户名</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>订阅 / 最近到期</TableHead>
                <TableHead>今日用量</TableHead>
                <TableHead className='text-end'>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className='h-24 text-center text-muted-foreground'
                  >
                    暂无用户
                  </TableCell>
                </TableRow>
              ) : null}
              {items.map((u) => {
                const isSelf = u.username === me?.user
                const subscriptions = active
                  .filter((s) => s.user_id === u.id)
                  .sort((a, b) => a.expires_at.localeCompare(b.expires_at))
                const use = summary?.users.find((s) => s.user_id === u.id)
                return (
                  <TableRow key={u.id}>
                    <TableCell className='font-medium'>
                      {u.username}
                      {isSelf ? (
                        <span className='ms-2 text-xs text-muted-foreground'>
                          (当前)
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={u.role === 'admin' ? 'default' : 'secondary'}
                      >
                        {ROLE_LABELS[u.role] || u.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {u.enabled === false ? (
                        <Badge variant='outline'>已停用</Badge>
                      ) : (
                        <Badge variant='secondary'>启用</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      {summary ? (
                        <>
                          <span
                            className='block max-w-52 truncate font-medium'
                            title={subscriptions
                              .map((s) => s.plan_name)
                              .join('、')}
                          >
                            {subscriptions.length
                              ? subscriptions.map((s) => s.plan_name).join('、')
                              : '无生效订阅'}
                          </span>
                          <span className='mt-1 block text-xs text-muted-foreground'>
                            {subscriptions[0]
                              ? new Date(
                                  subscriptions[0].expires_at
                                ).toLocaleDateString('zh-CN') + ' 到期'
                              : '—'}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className='tabular-nums'>
                      {summary ? (
                        <>
                          {(use?.requests || 0).toLocaleString()} 次
                          <span className='mt-1 block text-xs text-muted-foreground'>
                            {fmtUsd(use?.cost || 0)}
                          </span>
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className='space-x-1 text-end whitespace-nowrap'>
                      {u.role !== 'super' && (
                        <Button
                          size='sm'
                          variant='outline'
                          disabled={u.enabled === false}
                          onClick={() => setAssignUser(u.id)}
                        >
                          分配订阅
                        </Button>
                      )}
                      <Button
                        size='sm'
                        variant='ghost'
                        onClick={() => setDetail(u)}
                      >
                        详情
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size='icon'
                            variant='ghost'
                            aria-label={u.username + ' 更多操作'}
                          >
                            <MoreHorizontal className='size-4' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem onClick={() => setEdit(u)}>
                            <Pencil />
                            编辑用户
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setPwTarget(u)}>
                            <KeyRound />
                            修改密码
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={isSelf}
                            onClick={() => setDel(u)}
                            className='text-destructive'
                          >
                            <Trash2 />
                            删除用户
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </QueryGate>

      {detail && (
        <UserSubscriptionDetail
          key={detail.id}
          user={detail}
          data={summary}
          onClose={() => setDetail(null)}
          onAssign={() => {
            setAssignUser(detail.id)
            setDetail(null)
          }}
        />
      )}
      {assignUser && (
        <SubscriptionWizard
          preset={{ userId: assignUser }}
          onClose={() => setAssignUser(null)}
        />
      )}
      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onDone={refresh}
      />
      <EditUserDialog
        user={edit}
        isSelf={!!edit && edit.username === me?.user}
        onClose={() => setEdit(null)}
        onDone={refresh}
      />
      <PasswordDialog
        user={pwTarget}
        isSelf={!!pwTarget && pwTarget.username === me?.user}
        onClose={() => setPwTarget(null)}
        onDone={refresh}
      />
      <ConfirmDialog
        open={!!del}
        onOpenChange={() => setDel(null)}
        title={`删除 ${del?.username}`}
        desc='删除后该用户所有会话立即失效。不能删除最后一个管理员，也不能删除自己。'
        confirmText='删除'
        cancelBtnText='取消'
        destructive
        handleConfirm={() => {
          if (!del) return
          api(`/api/panel/users/${encodeURIComponent(del.id)}`, {
            method: 'DELETE',
          })
            .then(() => {
              toast.success('已删除')
              setDel(null)
              return refresh()
            })
            .catch((e: Error) => toast.error(e.message))
        }}
      />
    </PageHeader>
  )
}

function CreateUserDialog({
  open,
  onOpenChange,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => Promise<unknown>
}) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [role, setRole] = useState<PanelRole>('user')
  const [quota, setQuota] = useState(0)
  const [enabled, setEnabled] = useState(true)
  const pwErr = passwordError(password, confirm)

  const reset = () => {
    setUsername('')
    setPassword('')
    setConfirm('')
    setRole('user')
    setQuota(0)
    setEnabled(true)
  }

  const create = useMutation({
    mutationFn: () =>
      api('/api/panel/users', {
        method: 'POST',
        body: JSON.stringify({
          username: username.trim(),
          password,
          role,
          enabled,
          vm_create_quota: quota,
        }),
      }),
    onSuccess: async () => {
      toast.success('已创建')
      reset()
      onOpenChange(false)
      await onDone()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form
          className='space-y-4'
          onSubmit={(e) => {
            e.preventDefault()
            create.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>
              用户名 2–32 位，字母开头，仅字母数字 . _ -
            </DialogDescription>
          </DialogHeader>
          <Field id='new-username' label='用户名'>
            <Input
              id='new-username'
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete='off'
            />
          </Field>
          <PasswordFields
            password={password}
            setPassword={setPassword}
            confirm={confirm}
            setConfirm={setConfirm}
            error={pwErr}
          />
          <RoleFields
            role={role}
            setRole={setRole}
            enabled={enabled}
            setEnabled={setEnabled}
            quota={quota}
            setQuota={setQuota}
          />
          <DialogFooter>
            <Button
              type='submit'
              disabled={
                !username.trim() ||
                !password ||
                password !== confirm ||
                !!pwErr ||
                create.isPending
              }
              loading={create.isPending}
            >
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function EditUserDialog({
  user,
  isSelf,
  onClose,
  onDone,
}: {
  user: PanelUser | null
  isSelf: boolean
  onClose: () => void
  onDone: () => Promise<unknown>
}) {
  // Keyed by user id so the draft resets whenever a different row opens.
  return (
    <Dialog open={!!user} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {user ? (
          <EditUserForm
            key={user.id}
            user={user}
            isSelf={isSelf}
            onClose={onClose}
            onDone={onDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function EditUserForm({
  user,
  isSelf,
  onClose,
  onDone,
}: {
  user: PanelUser
  isSelf: boolean
  onClose: () => void
  onDone: () => Promise<unknown>
}) {
  const [role, setRole] = useState<PanelRole>(user.role)
  const [enabled, setEnabled] = useState(user.enabled !== false)
  const [quota, setQuota] = useState(user.vm_create_quota ?? 0)

  const patch = useMutation({
    mutationFn: () =>
      api(`/api/panel/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ role, enabled, vm_create_quota: quota }),
      }),
    onSuccess: async () => {
      toast.success('已更新')
      onClose()
      await onDone()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <form
      className='space-y-4'
      onSubmit={(e) => {
        e.preventDefault()
        patch.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>编辑 {user.username}</DialogTitle>
      </DialogHeader>
      <RoleFields
        role={role}
        setRole={setRole}
        enabled={enabled}
        setEnabled={setEnabled}
        quota={quota}
        setQuota={setQuota}
        lockSelf={isSelf}
      />
      <DialogFooter>
        <Button
          type='submit'
          disabled={patch.isPending}
          loading={patch.isPending}
        >
          保存
        </Button>
      </DialogFooter>
    </form>
  )
}

function PasswordDialog({
  user,
  isSelf,
  onClose,
  onDone,
}: {
  user: PanelUser | null
  isSelf: boolean
  onClose: () => void
  onDone: () => Promise<unknown>
}) {
  return (
    <Dialog open={!!user} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        {user ? (
          <PasswordForm
            key={user.id}
            user={user}
            isSelf={isSelf}
            onClose={onClose}
            onDone={onDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function PasswordForm({
  user,
  isSelf,
  onClose,
  onDone,
}: {
  user: PanelUser
  isSelf: boolean
  onClose: () => void
  onDone: () => Promise<unknown>
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const pwErr = passwordError(password, confirm)

  const save = useMutation({
    mutationFn: () =>
      api(`/api/panel/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ password }),
      }),
    onSuccess: async () => {
      toast.success(
        isSelf
          ? '密码已修改，其它设备的会话已退出'
          : '密码已修改，该用户需重新登录'
      )
      onClose()
      await onDone()
    },
    onError: (error: Error) => toast.error(error.message),
  })

  return (
    <form
      className='space-y-4'
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <DialogHeader>
        <DialogTitle>修改密码 · {user.username}</DialogTitle>
        <DialogDescription>
          {isSelf
            ? '保存后当前会话保留，其它设备上的登录会失效。'
            : '保存后该用户所有已登录会话立即失效。'}
        </DialogDescription>
      </DialogHeader>
      <PasswordFields
        password={password}
        setPassword={setPassword}
        confirm={confirm}
        setConfirm={setConfirm}
        error={pwErr}
        newLabel='新密码'
      />
      <DialogFooter>
        <Button type='button' variant='outline' onClick={onClose}>
          取消
        </Button>
        <Button
          type='submit'
          disabled={
            !password || password !== confirm || !!pwErr || save.isPending
          }
          loading={save.isPending}
        >
          保存密码
        </Button>
      </DialogFooter>
    </form>
  )
}

function Field({
  id,
  label,
  children,
}: {
  id?: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}

function PasswordFields({
  password,
  setPassword,
  confirm,
  setConfirm,
  error,
  newLabel = '密码',
}: {
  password: string
  setPassword: (v: string) => void
  confirm: string
  setConfirm: (v: string) => void
  error: string
  newLabel?: string
}) {
  return (
    <>
      <Field id='pw-new' label={newLabel}>
        <PasswordInput
          id='pw-new'
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete='new-password'
          placeholder={`${PASSWORD_MIN}–${PASSWORD_MAX} 位`}
          aria-invalid={!!error}
          aria-describedby={error ? 'pw-error' : undefined}
        />
      </Field>
      <Field id='pw-confirm' label='确认密码'>
        <PasswordInput
          id='pw-confirm'
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete='new-password'
          aria-invalid={!!error}
          aria-describedby={error ? 'pw-error' : undefined}
        />
      </Field>
      {error ? (
        <p id='pw-error' role='alert' className='text-xs text-destructive'>
          {error}
        </p>
      ) : null}
    </>
  )
}

function RoleFields({
  role,
  setRole,
  enabled,
  setEnabled,
  quota,
  setQuota,
  lockSelf,
}: {
  role: PanelRole
  setRole: (role: PanelRole) => void
  enabled: boolean
  setEnabled: (on: boolean) => void
  quota: number
  setQuota: (n: number) => void
  lockSelf?: boolean
}) {
  return (
    <>
      <Field id='user-role' label='角色'>
        <Select
          value={role}
          onValueChange={(v) => setRole(v as PanelRole)}
          disabled={lockSelf}
        >
          <SelectTrigger id='user-role' className='w-full'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ROLE_LABELS) as PanelRole[]).map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]} ({r})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field id='user-quota' label='自建 VM 配额 (0–100)'>
        <Input
          id='user-quota'
          type='number'
          min={0}
          max={100}
          value={quota}
          onChange={(e) =>
            setQuota(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
          }
        />
      </Field>
      <div className='flex items-center justify-between'>
        <Label htmlFor='user-enabled'>启用</Label>
        <Switch
          id='user-enabled'
          checked={enabled}
          onCheckedChange={setEnabled}
          disabled={lockSelf}
        />
      </div>
      {lockSelf ? (
        <p className='text-xs text-muted-foreground'>
          不能修改自己的角色或停用自己 ——
          保存后会立刻失去访问权限，且无法自助恢复。
        </p>
      ) : null}
    </>
  )
}
