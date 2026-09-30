/**
 * Slot lifecycle for VMs placed on a cluster node (`vm.node_id`). Same shape
 * and return contract as vm-runtime's startVmRuntime / stopVmRuntime /
 * destroyVmRuntime / reloadSlotWorker, but every Docker call goes through the
 * Engine API over the node's SSH link (never the synchronous docker CLI, which
 * would deadlock on the in-process bridge).
 *
 * Remote layout (SSH user's HOME, no sudo):
 *   <root>/vms/<id>/{cli-home,run,machine-id}   bind-mounted like a local slot
 *   <root>/egress/<proxy>/egress.json           kin-egress config (SOCKS exits)
 */

import crypto from 'node:crypto'
import path from 'node:path'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'
import {
  boundProxyUrl,
  bridgeName,
  chainName,
  configuredDnsUpstream,
  gatewayFromSubnet,
  iptablesPlan,
  isLocalEgressProxy,
  LOCAL_EGRESS_ID,
  networkName,
  portsForProxy,
  proxyKey,
} from '../vm/egress.mjs'
import { OS_CATALOG } from '../vm/os-catalog.mjs'
import { REMOTE_KERNEL_ENTRY, resolveKernelDataplane } from '../vm/slot-engine.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import {
  containerName,
  displayName,
  normalizeTimezone,
  SLOT_MEMORY,
  STANDARD_LOCALE,
  writeWorkerFiles,
} from '../vm/vm-runtime.mjs'
import {
  containerAction,
  createContainerRaw,
  createNetwork,
  execDetached,
  imagePresent,
  inspectContainerOrNull,
  inspectNetworkOrNull,
  removeContainer,
  removeNetwork,
} from './docker-remote.mjs'
import {
  clusterManager,
  nodeSession,
  parseMemoryBytes,
  remoteSlotDir,
  remoteSlotOwner,
  vmNodeId,
} from './placement.mjs'
import { openSftp, runRemote, shellQuote, writeRemoteFile } from './remote-fs.mjs'
import { pushSlotFiles, reconcileSlotCredentials, removeRemoteSlotDir } from './remote-slot-files.mjs'
import { REMOTE_WORKER_BIN, slotImageSpec } from './slot-image.mjs'

function failure(err, fallbackCode = 'remote_slot_failed') {
  return { ok: false, code: err?.code || fallbackCode, error: String(err?.message || err) }
}

/** iptables plan → one shell script; mirrors egress.mjs applyIptables (-N tolerant, -C guards the next row). */
export function remoteIptablesScript(plan, { sudo = false } = {}) {
  const ipt = `${sudo ? 'sudo -n ' : ''}iptables`
  const line = (args) => `${ipt} ${args.map(shellQuote).join(' ')}`
  const out = ['set -e']
  for (let i = 0; i < plan.add.length; i++) {
    const args = plan.add[i]
    if (args.includes('-N')) {
      out.push(`${line(args)} 2>/dev/null || true`)
      continue
    }
    if (args.includes('-C')) {
      out.push(`${line(args)} 2>/dev/null || ${line(plan.add[i + 1])}`)
      i += 1
      continue
    }
    out.push(line(args))
  }
  return out.join('\n')
}

async function ensureRemoteNetwork(docker, proxyId, { masquerade }) {
  const name = networkName(proxyId)
  if (!name) throw Object.assign(new Error('proxy id required'), { code: 'proxy_id_required' })
  let info = await inspectNetworkOrNull(docker, name)
  if (!info) {
    await createNetwork(docker, {
      Name: name,
      Driver: 'bridge',
      EnableIPv6: false,
      Options: {
        'com.docker.network.bridge.name': bridgeName(proxyId),
        'com.docker.network.bridge.enable_ip_masquerade': masquerade ? 'true' : 'false',
        'com.docker.network.bridge.enable_icc': 'false',
      },
    })
    info = await inspectNetworkOrNull(docker, name)
  }
  const subnet = info?.IPAM?.Config?.[0]?.Subnet || ''
  if (!subnet) throw Object.assign(new Error(`egress network ${name} has no subnet`), { code: 'egress_network_failed' })
  const gateway = info.IPAM.Config[0].Gateway || gatewayFromSubnet(subnet)
  return { name, subnet, gateway, bridge: bridgeName(proxyId) }
}

/**
 * Build the VM's exit on the node. px-local = masquerading bridge (node's own IP).
 * SOCKS = non-masquerading bridge + kin-egress (host-network container from the
 * slot image) + iptables REDIRECT, exactly like egress.mjs does on the control plane.
 */
export async function ensureRemoteEgress(session, proxy, { imageRef }) {
  if (isLocalEgressProxy(proxy)) {
    const net = await ensureRemoteNetwork(session.docker, proxy?.id || LOCAL_EGRESS_ID, { masquerade: true })
    return { ok: true, mode: 'local', network: net.name }
  }
  const proxyId = proxy?.id
  const proxyUrl = boundProxyUrl(proxy)
  if (!proxyId || !proxyUrl) {
    return { ok: false, code: 'proxy_required', error: 'bound SOCKS5 id and url required; refusing fallback' }
  }
  if (session.host.uid !== 0 && !session.host.sudo) {
    return { ok: false, code: 'egress_sudo_required', error: '节点需要 root 或免密 sudo 才能为 SOCKS5 出口写 iptables' }
  }
  const net = await ensureRemoteNetwork(session.docker, proxyId, { masquerade: false })
  const ports = portsForProxy(proxyId)
  const cfg = {
    proxy_id: proxyId,
    proxy_url: proxyUrl,
    listen_tcp: `${net.gateway}:${ports.tcp}`,
    listen_dns: `${net.gateway}:${ports.dns}`,
  }
  const dnsUpstream = configuredDnsUpstream()
  if (dnsUpstream) cfg.dns_upstream = dnsUpstream
  const body = `${JSON.stringify(cfg, null, 2)}\n`
  const digest = crypto.createHash('sha256').update(body).update(imageRef).digest('hex').slice(0, 16)
  const key = proxyKey(proxyId)
  const dir = `${session.host.root}/egress/${key}`
  const owner = session.host.uid === 0 ? null : { uid: session.host.uid, gid: session.host.gid }
  const name = `kin-egress-${key}`
  const existing = await inspectContainerOrNull(session.docker, name)
  if (!(existing?.State?.Running && existing.Config?.Labels?.['kin.egress.cfg'] === digest)) {
    await runRemote(session.client, `umask 077 && mkdir -p ${shellQuote(dir)} && chmod 700 ${shellQuote(dir)}`)
    await writeRemoteFile(await openSftp(session.client), `${dir}/egress.json`, body, { mode: 0o600 })
    if (existing) await removeContainer(session.docker, name)
    await createContainerRaw(session.docker, name, {
      Image: imageRef,
      ...(owner ? { User: `${owner.uid}:${owner.gid}` } : {}),
      Cmd: ['/usr/local/bin/kin-egress', '-config', '/etc/kin-egress/egress.json'],
      Labels: { 'kin.egress': '1', 'kin.egress.proxy': proxyId, 'kin.egress.cfg': digest },
      HostConfig: {
        NetworkMode: 'host',
        Binds: [`${dir}:/etc/kin-egress:ro`],
        RestartPolicy: { Name: 'unless-stopped' },
        ReadonlyRootfs: true,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
      },
    })
    await containerAction(session.docker, name, 'start')
  }
  // Passive: a TCP connect would enter kin-egress's transparent path (it refuses self-destined conns).
  const listen = `${net.gateway}:${ports.tcp}`
  const probe = `for i in $(seq 1 40); do ss -H -ltn 'sport = :${ports.tcp}' | awk '{print $4}' | grep -qxF -e '${listen}' -e '0.0.0.0:${ports.tcp}' -e '*:${ports.tcp}' && exit 0; sleep 0.2; done; exit 1`
  await runRemote(session.client, `bash -c ${shellQuote(probe)}`, { timeoutMs: 20_000, code: 'egress_not_listening' })
  const plan = iptablesPlan({
    chain: chainName(proxyId),
    bridge: net.bridge,
    subnet: net.subnet,
    tcpPort: ports.tcp,
    dnsPort: ports.dns,
  })
  await runRemote(session.client, remoteIptablesScript(plan, { sudo: session.host.uid !== 0 }), {
    code: 'egress_iptables_failed',
  })
  return { ok: true, mode: 'socks', network: net.name }
}

/**
 * Remote twin of stopProxyEgress, run when a slot leaves an exit network. The
 * node keeps an exit only while some container still sits on it; the network's
 * own container list is the node-local truth (the proxy may still bind VMs elsewhere).
 */
export async function releaseRemoteEgress(session, networkMode) {
  const name = String(networkMode || '')
  if (!name.startsWith('kin-eg-')) return { released: false }
  const proxyId = name.slice('kin-eg-'.length)
  const info = await inspectNetworkOrNull(session.docker, name)
  if (!info) return { released: false }
  if (Object.keys(info.Containers || {}).length) return { released: false, reason: 'in_use' }
  const key = proxyKey(proxyId)
  const egress = `kin-egress-${key}`
  if (await inspectContainerOrNull(session.docker, egress)) await removeContainer(session.docker, egress)
  const subnet = info.IPAM?.Config?.[0]?.Subnet
  if (subnet && !isLocalEgressProxy({ id: proxyId })) {
    const plan = iptablesPlan({
      chain: chainName(proxyId),
      bridge: bridgeName(proxyId),
      subnet,
      tcpPort: portsForProxy(proxyId).tcp,
      dnsPort: portsForProxy(proxyId).dns,
    })
    const ipt = `${session.host.uid !== 0 ? 'sudo -n ' : ''}iptables`
    // Each row may already be gone; deletion keeps going like the local removeIptables.
    const script = plan.del.map((args) => `${ipt} ${args.map(shellQuote).join(' ')} 2>/dev/null || true`).join('\n')
    await runRemote(session.client, script, { code: 'egress_iptables_failed' })
  }
  await removeNetwork(session.docker, name)
  await runRemote(session.client, `rm -rf ${shellQuote(`${session.host.root}/egress/${key}`)}`)
  return { released: true, network: name }
}

function slotContainerBody(vm, { image, network, remoteDir, user }) {
  const slotName = displayName(vm.id)
  const mem = parseMemoryBytes(SLOT_MEMORY)
  return {
    Image: image,
    Hostname: String(vm.fingerprint?.hostname || '').trim() || slotName,
    User: user,
    WorkingDir: '/home/kincli',
    Env: [
      'HOME=/home/kincli',
      'CLAUDE_CONFIG_DIR=/home/kincli/.claude',
      `TZ=${vm.timezone}`,
      `LANG=${vm.locale}`,
      `KIN_VM_ID=${vm.id}`,
      `KIN_VM_NAME=${slotName}`,
      `KIN_VM_OS=${vm.kernel}`,
    ],
    Cmd: [REMOTE_KERNEL_ENTRY, '--gateway-worker', '--config', '/run/kin/kernel.json'],
    Labels: {
      'kin.vm': '1',
      'kin.vm.id': vm.id,
      'kin.vm.name': slotName,
      'kin.vm.os': vm.kernel,
      'vm2api.cluster': '1',
    },
    HostConfig: {
      Binds: [
        `${remoteDir}/cli-home:/home/kincli`,
        `${remoteDir}/run:/run/kin`,
        `${remoteDir}/machine-id:/etc/machine-id:ro`,
        `${remoteDir}/machine-id:/var/lib/dbus/machine-id:ro`,
      ],
      NetworkMode: network,
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: mem,
      MemorySwap: mem,
      PidsLimit: 256,
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m' },
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      Dns: ['8.8.8.8'],
      DnsOptions: ['use-vc'],
    },
  }
}

function applyRuntime(vm, { nodeId, name, info, image, network, user, relays, slotDir, egress }) {
  vm.runtime = {
    ...(vm.runtime || {}),
    type: 'docker',
    node_id: nodeId,
    container: name,
    container_id: info?.Id || vm.runtime?.container_id || null,
    pid: null,
    ip: null,
    network,
    network_mode: network,
    started_at: info?.State?.StartedAt || null,
    image,
    hostname: info?.Config?.Hostname || null,
    os: (OS_CATALOG[vm.kernel] || {}).pretty || vm.kernel,
    memory: SLOT_MEMORY,
    user,
    worker: 'rust',
    worker_socket: relays.worker,
    kernel_socket: relays.kernel,
    worker_run_dir: path.join(slotDir, 'run'),
    worker_token_file: path.join(slotDir, 'run', 'internal.token'),
    egress,
    stopped: false,
  }
}

async function prepare(vm, projectRoot, routing) {
  if (isCodexVm(vm)) {
    return { fail: { ok: false, code: 'remote_unsupported', error: 'GPT 槽位暂不支持放到集群节点' } }
  }
  if (resolveKernelDataplane(vm, routing || {}) === 'crag') {
    return { fail: { ok: false, code: 'remote_unsupported', error: 'crag 数据面暂不支持集群节点' } }
  }
  vm.kernel = vm.kernel && OS_CATALOG[vm.kernel] ? vm.kernel : 'ubuntu-24.04'
  vm.timezone = normalizeTimezone(vm.timezone)
  vm.locale = vm.locale || STANDARD_LOCALE
  const nodeId = vmNodeId(vm)
  const session = await nodeSession(nodeId)
  const spec = slotImageSpec(projectRoot, vm.kernel)
  if (!(await imagePresent(session.docker, spec.ref))) {
    return {
      fail: {
        ok: false,
        code: 'slot_image_missing',
        error: `节点 ${nodeId} 缺少槽位镜像 ${spec.ref}，先在创建弹窗准备镜像`,
      },
    }
  }
  const owner = remoteSlotOwner(session.host, vm)
  return {
    nodeId,
    session,
    image: spec.ref,
    user: `${owner.uid}:${owner.gid}`,
    remoteDir: remoteSlotDir(session.host, vm.id),
    slotDir: path.join(projectRoot, 'vms', vm.id),
  }
}

/** Remote twin of startVmRuntime. Running + same image/network is left alone (Node restart must not bounce slots). */
export async function startRemoteSlot(vm, projectRoot, { recreate = false, routing } = {}) {
  try {
    const p = await prepare(vm, projectRoot, routing)
    if (p.fail) return p.fail
    const { nodeId, session, image, user, remoteDir, slotDir } = p
    const eg = await ensureRemoteEgress(session, vm.proxy, { imageRef: image })
    if (!eg.ok) return eg
    const name = containerName(vm.id)
    const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
    let existing = await inspectContainerOrNull(session.docker, name)
    const matches =
      existing && existing.Config?.Image === image && existing.HostConfig?.NetworkMode === eg.network && !recreate
    const common = { nodeId, name, image, network: eg.network, user, relays, slotDir, egress: eg.mode }
    if (matches && existing.State?.Running) {
      applyRuntime(vm, { ...common, info: existing })
      return { ok: true, action: 'already-running', runtime: vm.runtime }
    }
    writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
    ensureGuestMachineIdFile(projectRoot, vm)
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    await reconcileSlotCredentials(vm, slotDir, session)
    if (existing && !matches) {
      const previousNetwork = existing.HostConfig?.NetworkMode
      await removeContainer(session.docker, name)
      existing = null
      if (previousNetwork && previousNetwork !== eg.network) await releaseRemoteEgress(session, previousNetwork)
    }
    let action = 'started'
    if (!existing) {
      await createContainerRaw(
        session.docker,
        name,
        slotContainerBody(vm, { image, network: eg.network, remoteDir, user }),
      )
      action = 'created'
    }
    await containerAction(session.docker, name, 'start')
    await execDetached(session.docker, name, [
      REMOTE_WORKER_BIN,
      'telemetry',
      '--config',
      '/run/kin/worker.json',
    ]).catch(() => {})
    applyRuntime(vm, { ...common, info: await inspectContainerOrNull(session.docker, name) })
    return { ok: true, action, runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

/** Remote twin of reloadSlotWorker: rewrite + push config, bounce the container, never remove it unless the exit moved. */
export async function reloadRemoteSlot(vm, projectRoot, { routing } = {}) {
  try {
    const p = await prepare(vm, projectRoot, routing)
    if (p.fail) return p.fail
    const { nodeId, session, image, user, remoteDir, slotDir } = p
    const eg = await ensureRemoteEgress(session, vm.proxy, { imageRef: image })
    if (!eg.ok) return eg
    const name = containerName(vm.id)
    const existing = await inspectContainerOrNull(session.docker, name)
    if (!existing || existing.Config?.Image !== image || existing.HostConfig?.NetworkMode !== eg.network) {
      return startRemoteSlot(vm, projectRoot, { recreate: !!existing, routing })
    }
    const relays = await clusterManager().ensureSlotRelays(nodeId, vm.id)
    writeWorkerFiles(vm, projectRoot, { transparent: true, routing })
    await pushSlotFiles(vm, slotDir, ['run', 'seed'], session)
    await reconcileSlotCredentials(vm, slotDir, session)
    const running = !!existing.State?.Running
    await containerAction(session.docker, name, running ? 'restart' : 'start')
    await execDetached(session.docker, name, [
      REMOTE_WORKER_BIN,
      'telemetry',
      '--config',
      '/run/kin/worker.json',
    ]).catch(() => {})
    applyRuntime(vm, {
      nodeId,
      name,
      image,
      network: eg.network,
      user,
      relays,
      slotDir,
      egress: eg.mode,
      info: await inspectContainerOrNull(session.docker, name),
    })
    return { ok: true, action: running ? 'reloaded' : 'started', runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

export async function stopRemoteSlot(vm) {
  try {
    const session = await nodeSession(vmNodeId(vm))
    const name = containerName(vm.id)
    const info = await inspectContainerOrNull(session.docker, name)
    if (!info) {
      if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true }
      return { ok: true, action: 'absent', runtime: vm.runtime || null }
    }
    await containerAction(session.docker, name, 'stop')
    vm.runtime = { ...(vm.runtime || {}), pid: null, stopped: true }
    return { ok: true, action: 'stopped', runtime: vm.runtime }
  } catch (err) {
    return failure(err)
  }
}

/** Explicit delete / factory reset: container, node-side slot tree and local relays. */
export async function destroyRemoteSlot(vm) {
  try {
    const session = await nodeSession(vmNodeId(vm))
    const name = containerName(vm.id)
    const info = await inspectContainerOrNull(session.docker, name)
    if (info) {
      await removeContainer(session.docker, name)
      await releaseRemoteEgress(session, info.HostConfig?.NetworkMode)
    }
    await removeRemoteSlotDir(vm, session)
    await clusterManager().dropSlotRelays(vm.id)
    if (vm.runtime) vm.runtime = { ...vm.runtime, pid: null, ip: null, stopped: true, removed: true }
    return { ok: true, action: info ? 'removed' : 'absent', runtime: vm.runtime || null }
  } catch (err) {
    return failure(err)
  }
}
