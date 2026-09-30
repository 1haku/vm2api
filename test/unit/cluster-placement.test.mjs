import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { ClusterManager } from '../../src/lib/cluster/cluster-manager.mjs'
import { remoteSlotOwner } from '../../src/lib/cluster/placement.mjs'
import { remoteIptablesScript } from '../../src/lib/cluster/remote-slot.mjs'
import {
  pullSlotCredentials,
  pushSlotCredentials,
  reconcileSlotCredentials,
} from '../../src/lib/cluster/remote-slot-files.mjs'
import { slotImageSpec, tarStream } from '../../src/lib/cluster/slot-image.mjs'
import { SocketRelay } from '../../src/lib/cluster/socket-relay.mjs'
import { connectSsh } from '../../src/lib/cluster/ssh-link.mjs'
import { iptablesPlan } from '../../src/lib/vm/egress.mjs'

const { Server, utils } = ssh2

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** In-memory SFTP + exec double: enough of ssh2's client surface for remote-slot-files. */
function fakeNode(files = new Map()) {
  const sftp = new EventEmitter()
  const ok = (cb, v) => setImmediate(() => cb(null, v))
  const modes = new Map()
  sftp.writeFile = (p, data, opts, cb) => {
    files.set(p, Buffer.from(data))
    modes.set(p, opts.mode)
    ok(cb)
  }
  sftp.readFile = (p, cb) => {
    if (!files.has(p)) return setImmediate(() => cb(Object.assign(new Error('No such file'), { code: 2 })))
    ok(cb, files.get(p))
  }
  sftp.chmod = (_p, _m, cb) => ok(cb)
  sftp.chown = (_p, _u, _g, cb) => ok(cb)
  sftp.unlink = (p, cb) => {
    files.delete(p)
    ok(cb)
  }
  sftp.ext_openssh_rename = (from, to, cb) => {
    files.set(to, files.get(from))
    modes.set(to, modes.get(from))
    ok(cb)
  }
  sftp.symlink = (target, link, cb) => {
    files.set(link, `->${target}`)
    ok(cb)
  }
  const client = {
    sftp: (cb) => ok(cb, sftp),
    exec: (_cmd, cb) => {
      const stream = new EventEmitter()
      stream.stderr = new EventEmitter()
      stream.close = () => {}
      ok(cb, stream)
      setImmediate(() => {
        stream.emit('exit', 0)
        stream.emit('close')
      })
    },
  }
  const host = { uid: 1000, gid: 1000, home: '/home/ubuntu', root: '/home/ubuntu/.vm2api', sudo: true }
  return {
    files,
    modes,
    session: { nodeId: 'node-t', client, host },
    remoteCred: `${host.root}/vms/vm-07/cli-home/.claude/credentials.json`,
  }
}

function localSlot(cred) {
  const slotDir = path.join(tmpDir('kin-remote-slot-'), 'vm-07')
  fs.mkdirSync(path.join(slotDir, 'cli-home', '.claude'), { recursive: true })
  if (cred != null)
    fs.writeFileSync(path.join(slotDir, 'cli-home', '.claude', 'credentials.json'), cred, { mode: 0o444 })
  return slotDir
}

const vm = { id: 'vm-07', node_id: 'node-t' }

test('start reconcile never overwrites a remote credential the slot already rotated', async () => {
  const node = fakeNode()
  node.files.set(node.remoteCred, Buffer.from('{"rt":"rotated"}'))
  const slotDir = localSlot('{"rt":"stale"}')
  const r = await reconcileSlotCredentials(vm, slotDir, node.session)
  assert.equal(r.pulled, true)
  assert.equal(node.files.get(node.remoteCred).toString(), '{"rt":"rotated"}', 'remote copy must stay authoritative')
  const local = path.join(slotDir, 'cli-home', '.claude', 'credentials.json')
  assert.equal(fs.readFileSync(local, 'utf8'), '{"rt":"rotated"}')
  assert.equal(fs.statSync(local).mode & 0o777, 0o444, 'local seal survives the pull')
})

test('start reconcile seeds an empty node dir from the local credential', async () => {
  const node = fakeNode()
  const slotDir = localSlot('{"rt":"first"}')
  const r = await reconcileSlotCredentials(vm, slotDir, node.session)
  assert.equal(r.pushed, true)
  assert.equal(node.files.get(node.remoteCred).toString(), '{"rt":"first"}')
  assert.equal(
    node.files.get(`${node.session.host.root}/vms/vm-07/cli-home/.claude/.credentials.json`),
    '->credentials.json',
  )
})

test('explicit import replaces the node credential at 0600; identical pull is a no-op', async () => {
  const node = fakeNode()
  node.files.set(node.remoteCred, Buffer.from('{"rt":"old-account"}'))
  const slotDir = localSlot('{"rt":"imported"}')
  fs.chmodSync(path.join(slotDir, 'cli-home', '.claude', 'credentials.json'), 0o777)
  await pushSlotCredentials(vm, slotDir, node.session)
  assert.equal(node.files.get(node.remoteCred).toString(), '{"rt":"imported"}')
  assert.equal(node.modes.get(node.remoteCred), 0o600, 'a 0777 local checkout must not leak its mode to the node')
  assert.deepEqual(await pullSlotCredentials(vm, slotDir, node.session), { pulled: false, reason: 'same' })
})

test('remote slot runs as the SSH user unless that user is root', () => {
  assert.deepEqual(remoteSlotOwner({ uid: 1000, gid: 1001 }, { id: 'vm-03' }), { uid: 1000, gid: 1001 })
  const rootOwner = remoteSlotOwner({ uid: 0, gid: 0 }, { id: 'vm-03' })
  assert.equal(rootOwner.uid, 10003)
})

test('remote iptables script mirrors applyIptables semantics', () => {
  const plan = iptablesPlan({
    chain: 'KEGabc',
    bridge: 'kegabc',
    subnet: '172.30.0.0/16',
    tcpPort: 20000,
    dnsPort: 20001,
  })
  const script = remoteIptablesScript(plan, { sudo: true })
  const lines = script.split('\n')
  assert.equal(lines[0], 'set -e')
  assert.match(lines[1], /^sudo -n iptables '-t' 'nat' '-N' 'KEGabc' 2>\/dev\/null \|\| true$/)
  // -C guards exactly the following -A/-I; both halves on one line.
  assert.match(lines[2], /'-C' 'PREROUTING'.*\|\| sudo -n iptables .*'-A' 'PREROUTING'/)
  assert.ok(lines.at(-1).includes("'-C' 'FORWARD'") && lines.at(-1).includes("'-I' 'FORWARD' '1'"))
  assert.ok(script.includes("'!'"), 'negation is passed as its own quoted arg')
  assert.equal(lines.length, 1 + plan.add.length - 2, 'two -C rows fold into their guarded row')
  assert.doesNotMatch(remoteIptablesScript(plan, { sudo: false }), /sudo/)
})

function fakeElf(file, fill) {
  const buf = Buffer.alloc(128, fill)
  buf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0)
  buf.writeUInt16LE(62, 18)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
}

test('slot image tag follows payload bytes, not just VERSION', (t) => {
  const root = tmpDir('kin-slot-image-')
  fs.writeFileSync(path.join(root, 'VERSION'), '9.9.9\n')
  for (const f of [
    'share/wrap-cli/cli-node',
    'share/wrap-cli/cc-node',
    'bin/kin-kernel',
    'bin/kin-worker',
    'bin/kin-egress',
  ]) {
    fakeElf(path.join(root, f), 1)
  }
  fakeElf(path.join(root, 'bin/kin-codex-kernel'), 1)
  const envKeys = ['KIN_KERNEL_BIN', 'KIN_WORKER_BIN', 'KIN_EGRESS_BIN', 'KIN_CODEX_KERNEL_BIN', 'KIN_WRAP_CLI_ROOT']
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]))
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  for (const k of envKeys) delete process.env[k]
  process.env.KIN_CODEX_KERNEL_BIN = path.join(root, 'bin/kin-codex-kernel')
  fs.chmodSync(process.env.KIN_CODEX_KERNEL_BIN, 0o755)

  const a = slotImageSpec(root, 'ubuntu-24.04')
  assert.match(a.ref, /^vm2api\/kin-slot-ubuntu-24\.04:9\.9\.9-[0-9a-f]{12}$/)
  assert.equal(slotImageSpec(root, 'ubuntu-24.04').ref, a.ref)
  const cli = path.join(root, 'share/wrap-cli/cli-node')
  fakeElf(cli, 2)
  fs.utimesSync(cli, new Date(), new Date(Date.now() + 5000))
  assert.notEqual(slotImageSpec(root, 'ubuntu-24.04').ref, a.ref, 'rebuilt cli-node with same VERSION = new image')

  fs.writeFileSync(path.join(root, 'bin/kin-worker'), '#!/bin/sh\n')
  assert.throws(() => slotImageSpec(root, 'ubuntu-24.04'), { code: 'slot_payload_invalid' })
  assert.throws(() => slotImageSpec(root, 'nope-os'), { code: 'invalid_kernel' })
})

test('tar stream round-trips through system tar with modes intact', async (t) => {
  const dir = tmpDir('kin-tar-')
  const src = path.join(dir, 'blob')
  fs.writeFileSync(src, Buffer.alloc(1000, 7))
  const chunks = []
  for await (const c of tarStream([
    { name: 'Dockerfile', body: Buffer.from('FROM x\n'), mode: 0o644 },
    { name: 'opt/kin/blob', src, mode: 0o755 },
  ]))
    chunks.push(c)
  const tarFile = path.join(dir, 'ctx.tar')
  fs.writeFileSync(tarFile, Buffer.concat(chunks))
  let listing
  try {
    listing = execFileSync('tar', ['-tvf', tarFile], { encoding: 'utf8' })
  } catch {
    t.skip('tar unavailable')
    return
  }
  assert.match(listing, /-rw-r--r--.* Dockerfile/)
  assert.match(listing, /-rwxr-xr-x.* 1000 .*opt\/kin\/blob/)
  const out = path.join(dir, 'x')
  fs.mkdirSync(out)
  execFileSync('tar', ['-xf', tarFile, '-C', out])
  assert.ok(fs.readFileSync(path.join(out, 'opt/kin/blob')).equals(fs.readFileSync(src)))
})

test('socket relay resolves the remote path lazily and reaches a unix socket over streamlocal', async (t) => {
  const hostKey = utils.generateKeyPairSync('ed25519')
  const asked = []
  const server = new Server({ hostKeys: [hostKey.private] }, (conn) => {
    conn.on('authentication', (ctx) => ctx.accept())
    conn.on('ready', () => {})
    conn.on('error', () => {})
    conn.on('session', () => {})
    conn.on('openssh.streamlocal', (accept, reject, info) => {
      asked.push(info.socketPath)
      if (info.socketPath !== '/remote/run/kernel.sock') return reject()
      const ch = accept()
      // Like a hijacked `docker exec`: read until the client half-closes, answer afterwards.
      const got = []
      ch.on('data', (d) => got.push(d))
      ch.on('end', () =>
        setTimeout(() => {
          ch.end(Buffer.concat([Buffer.from('echo:'), ...got]))
        }, 30),
      )
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { client } = await connectSsh({
    host: '127.0.0.1',
    port: server.address().port,
    username: 'u',
    authType: 'password',
    password: 'x',
  })
  const dir = tmpDir('kin-relay-')
  let target = '/remote/run/kernel.sock'
  const relay = new SocketRelay({
    socketPath: path.join(dir, 'kernel.sock'),
    remotePath: async () => target,
    getClient: () => client,
  })
  t.after(async () => {
    await relay.stop()
    client.end()
    server.close()
  })
  await relay.start()
  assert.equal(fs.statSync(relay.socketPath).mode & 0o777, 0o600)
  const reply = await new Promise((resolve, reject) => {
    const chunks = []
    const s = net.connect({ path: relay.socketPath, allowHalfOpen: true }, () => s.end('ping'))
    s.on('data', (d) => chunks.push(d))
    s.once('close', () => resolve(Buffer.concat(chunks).toString()))
    s.once('error', reject)
  })
  assert.equal(reply, 'echo:ping', 'output after the client half-closes must still arrive')

  target = '/remote/run/missing.sock'
  const closed = await new Promise((resolve) => {
    const s = net.connect(relay.socketPath)
    s.once('close', () => resolve(true))
    s.on('error', () => {})
  })
  assert.equal(closed, true, 'a missing remote socket closes the local connection (caller sees not-ready)')
  assert.deepEqual(asked, ['/remote/run/kernel.sock', '/remote/run/missing.sock'])
})

test('a node with placed VMs cannot be removed', async () => {
  const manager = new ClusterManager({
    repo: { get: () => ({ id: 'n1' }), dependentsOf: () => [] },
    dataDir: '/tmp',
    vmsOnNode: () => [{ id: 'vm-02' }],
  })
  await assert.rejects(manager.remove('n1'), { code: 'node_has_vms' })
})
