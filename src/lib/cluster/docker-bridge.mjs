/**
 * Local unix socket that relays to the node's remote docker.sock over the
 * node's SSH link, so the host's own docker CLI can drive the remote daemon:
 *   DOCKER_HOST=unix://<data>/cluster/<id>/docker.sock docker ps
 * Unix socket + 0600 only; never a TCP port (that would hand root on the VPS
 * to anything that can reach it).
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { DOCKER_SOCKET_PATH } from './docker-remote.mjs'
import { forwardOutStreamLocal } from './ssh-link.mjs'

export class DockerBridge {
  /**
   * @param {{ socketPath: string, getClient: () => import('ssh2').Client|null, logger?: Pick<Console, 'warn'> }} opts
   */
  constructor({ socketPath, getClient, logger = console }) {
    this.socketPath = socketPath
    this.getClient = getClient
    this.logger = logger
    this.server = null
    this.listening = false
    this.error = null
    this.active = new Set()
  }

  snapshot() {
    return { socket_path: this.socketPath, listening: this.listening, error: this.error, active: this.active.size }
  }

  async start() {
    try {
      await this._listen()
    } catch (err) {
      this.server = null
      this.error =
        err.code === 'ENOTSUP'
          ? `${err.message}（该文件系统不支持 unix socket，设置 VM2API_CLUSTER_SOCKET_DIR）`
          : err.message
      throw err
    }
  }

  async _listen() {
    if (this.server) return
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 })
    fs.rmSync(this.socketPath, { force: true })
    const server = net.createServer((local) => this._relay(local))
    this.server = server
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    fs.chmodSync(this.socketPath, 0o600)
    server.on('error', (err) => this.logger.warn(`[cluster] docker bridge ${this.socketPath}: ${err.message}`))
    this.listening = true
  }

  async _relay(local) {
    this.active.add(local)
    local.once('close', () => this.active.delete(local))
    local.on('error', () => {})
    const client = this.getClient()
    if (!client) {
      local.destroy()
      return
    }
    let remote
    try {
      remote = await forwardOutStreamLocal(client, DOCKER_SOCKET_PATH)
    } catch (err) {
      this.logger.warn(`[cluster] docker bridge relay: ${err.message}`)
      local.destroy()
      return
    }
    if (local.destroyed) {
      remote.close()
      return
    }
    remote.on('error', () => local.destroy())
    remote.on('close', () => local.destroy())
    local.on('close', () => remote.close())
    local.pipe(remote)
    remote.pipe(local)
  }

  async stop() {
    const server = this.server
    this.server = null
    this.listening = false
    for (const sock of this.active) sock.destroy()
    this.active.clear()
    if (server) await new Promise((resolve) => server.close(() => resolve()))
    fs.rmSync(this.socketPath, { force: true })
  }
}
