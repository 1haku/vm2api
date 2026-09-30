/**
 * File operations on a cluster node over the node's SSH link. SFTP runs as the
 * SSH user, so the remote slot tree lives under that user's HOME and needs no
 * sudo. Writes are temp + rename: kin-kernel hot-reloads kernel.json and must
 * never read a half-written file.
 */

import { ClusterError, execCollect } from './ssh-link.mjs'

const sessions = new WeakMap()

export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** One cached SFTP subsystem per SSH client; dropped when either side closes. */
export function openSftp(client) {
  const cached = sessions.get(client)
  if (cached) return cached
  const pending = new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(new ClusterError(502, 'sftp_failed', `打开 SFTP 失败：${err.message}`))
      sftp.once('close', () => {
        if (sessions.get(client) === pending) sessions.delete(client)
      })
      resolve(sftp)
    })
  })
  pending.catch(() => sessions.delete(client))
  sessions.set(client, pending)
  return pending
}

function call(fn) {
  return new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))))
}

function sftpError(err, what) {
  return new ClusterError(502, 'sftp_failed', `${what}：${err?.message || err}`)
}

/**
 * Atomic write. `owner` is only set when the SSH user is root (the slot then
 * runs as 10000+n and must own its files); a non-root SSH user already is the slot uid.
 */
export async function writeRemoteFile(sftp, file, data, { mode = 0o600, owner = null } = {}) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    await call((cb) => sftp.writeFile(tmp, data, { mode }, cb))
    await call((cb) => sftp.chmod(tmp, mode, cb))
    if (owner) await call((cb) => sftp.chown(tmp, owner.uid, owner.gid, cb))
    await call((cb) => sftp.ext_openssh_rename(tmp, file, cb))
  } catch (err) {
    await call((cb) => sftp.unlink(tmp, cb)).catch(() => {})
    throw sftpError(err, `写入 ${file} 失败`)
  }
}

/** File bytes, or null when it does not exist. */
export async function readRemoteFile(sftp, file) {
  try {
    return await call((cb) => sftp.readFile(file, cb))
  } catch (err) {
    if (err?.code === 2) return null
    throw sftpError(err, `读取 ${file} 失败`)
  }
}

/** Symlink ownership is never checked by the kernel, so root-created links are fine. */
export async function remoteSymlink(sftp, target, linkPath) {
  await call((cb) => sftp.unlink(linkPath, cb)).catch(() => {})
  try {
    await call((cb) => sftp.symlink(target, linkPath, cb))
  } catch (err) {
    throw sftpError(err, `创建链接 ${linkPath} 失败`)
  }
}

/** Run a shell script; non-zero exit is an error carrying stderr. */
export async function runRemote(client, script, { timeoutMs = 60_000, code = 'remote_exec_failed' } = {}) {
  const r = await execCollect(client, `sh -c ${shellQuote(script)}`, { timeoutMs })
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout || `exit ${r.code}`).trim().slice(-500)
    throw new ClusterError(502, code, detail)
  }
  return r.stdout
}
