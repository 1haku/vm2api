/** Minimal QEMU Machine Protocol client over a Unix socket: greeting, capabilities, id-matched commands. */
import net from 'node:net'

const MAX_BUFFER = 4 * 1024 * 1024
const MAX_EVENTS = 256

function qmpError(code, message) {
  return Object.assign(new Error(message), { code })
}

/**
 * Resolves after the greeting and `qmp_capabilities`. Connection failures keep the
 * socket error code (ENOENT/ECONNREFUSED) so callers can poll for startup.
 */
export async function qmpConnect(socketPath, { timeoutMs = 5000 } = {}) {
  const socket = net.createConnection({ path: socketPath })
  socket.setEncoding('utf8')
  const waiters = new Map()
  const events = []
  let buffer = ''
  let seq = 0
  let failure = null
  let greet
  const greeting = new Promise((resolve, reject) => {
    greet = { resolve, reject }
  })

  const fail = (error) => {
    if (failure) return
    failure = error
    greet.reject(error)
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    waiters.clear()
  }

  socket.on('data', (chunk) => {
    buffer += chunk
    if (buffer.length > MAX_BUFFER) {
      fail(qmpError('qmp_protocol', 'QMP message exceeds the size limit'))
      socket.destroy()
      return
    }
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        fail(qmpError('qmp_protocol', 'QMP sent a non-JSON line'))
        socket.destroy()
        return
      }
      if (message.QMP) {
        greet.resolve(message.QMP)
        continue
      }
      if (message.event) {
        if (events.length < MAX_EVENTS) events.push(message)
        continue
      }
      const waiter = waiters.get(message.id)
      if (!waiter) continue
      waiters.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) {
        waiter.reject(
          qmpError('qmp_command_failed', `${waiter.command}: ${message.error.class}: ${message.error.desc}`),
        )
      } else {
        waiter.resolve(message.return)
      }
    }
  })
  socket.on('error', (error) => fail(error))
  socket.on('close', () => fail(qmpError('qmp_closed', 'QMP connection closed')))

  const execute = (command, args) => {
    if (failure) return Promise.reject(failure)
    seq += 1
    const id = `kin-${seq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(qmpError('qmp_timeout', `${command} timed out`))
      }, timeoutMs)
      waiters.set(id, { resolve, reject, timer, command })
      socket.write(`${JSON.stringify(args ? { execute: command, arguments: args, id } : { execute: command, id })}\n`)
    })
  }

  const greetTimer = setTimeout(() => {
    fail(qmpError('qmp_timeout', 'QMP greeting timed out'))
    socket.destroy()
  }, timeoutMs)
  try {
    await greeting
  } catch (error) {
    socket.destroy()
    throw error
  } finally {
    clearTimeout(greetTimer)
  }
  try {
    await execute('qmp_capabilities')
  } catch (error) {
    socket.destroy()
    throw error
  }
  return {
    execute,
    events,
    close: () => socket.destroy(),
  }
}
