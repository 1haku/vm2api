/**
 * Host-side slot lifecycle. Docker is implemented; KVM is a same-shaped
 * adapter that refuses until a hypervisor is wired. Guest identity / SOCKS
 * / TLS stay inside the rust kernel and must not branch here.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ensureRustKernel,
  kernelBinPath,
  restartRustKernel,
  writeKernelConfig,
} from '../transport/rust-kernel-supervisor.mjs'
import { ensureCodexKernel, stopCodexKernel, writeCodexKernelConfig } from '../transport/codex-kernel-supervisor.mjs'
import { runtimeKind, RUNTIME_KVM } from './runtime-kind.mjs'
import { getVm, listVms, isCodexVm, persistVmRuntime } from './vm-registry.mjs'
import { resolveInferenceEngine } from './slot-engine.mjs'
import {
  containerHasKernelMount,
  containerName,
  inspectContainer,
  startVmRuntime,
  reloadSlotWorker,
} from './vm-runtime.mjs'
import { inspectWrapCliDir, materializeWrapCli, wrapCliHomeDir } from './wrap-cli-runtime.mjs'
import { boundProxyUrl, isLocalEgressProxy } from './egress.mjs'
import { slotHost } from './slot-host.mjs'
import {
  beginGuestProvisioning,
  advanceGuestProvisioning,
  cancelGuestProvisioning,
  guestProvisioningToken,
  finishGuestStop,
} from './provisioning.mjs'
import { collectSlotIdentity } from './guest-identity.mjs'
import { rustKernelHealth } from '../transport/rust-kernel-client.mjs'
import { codexKernelHealth } from '../transport/codex-kernel-client.mjs'
import { readCodexAccounts } from './codex-slot.mjs'

export { runtimeKind }

const KVM_NOT_CONFIGURED = {
  ok: false,
  code: 'kvm_not_configured',
  error: 'kvm runtime adapter is not configured',
}

function kvmRefuse(action) {
  return { ...KVM_NOT_CONFIGURED, action, runtime: RUNTIME_KVM }
}

function unsupportedOnHost(action) {
  return { ok: false, code: 'remote_unsupported', error: `集群节点上的槽位不支持：${action}` }
}

export function startSlot(vm, projectRoot, opts = {}) {
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('start')
  return slotHost(vm).start(vm, projectRoot, opts)
}

export async function startSlotReady(vm, projectRoot, opts = {}) {
  if (isCodexVm(vm) && !slotHost(vm).supports('codex')) return unsupportedOnHost('codex')
  let token
  try {
    token = await beginGuestProvisioning(vm, projectRoot)
  } catch (error) {
    return { ok: false, code: error.code || 'guest_provisioning_invalid', error: error.message }
  }
  let boot
  try {
    boot = await startSlot(vm, projectRoot, opts)
    if (!boot?.ok) {
      await advanceGuestProvisioning(vm, projectRoot, token, opts.signal?.aborted ? 'cancelled' : 'failed', {
        errorCode: boot?.code || 'runtime_start_failed',
      })
      return boot
    }
    return await attachInferenceRuntime(boot, vm, projectRoot, { ...opts, guestToken: token })
  } catch (error) {
    await advanceGuestProvisioning(vm, projectRoot, token, opts.signal?.aborted ? 'cancelled' : 'failed', {
      errorCode: error.code || 'runtime_start_failed',
    })
    return { ok: false, code: error.code || 'runtime_start_failed', error: error.message }
  }
}

export async function stopSlot(vm, projectRoot) {
  await cancelGuestProvisioning(vm, projectRoot)
  if (isCodexVm(vm) && !vm.guest_user) stopCodexKernel(vm.id)
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('stop')
  const halt = await slotHost(vm).stop(vm, projectRoot)
  if (halt?.ok && projectRoot) {
    const saved = await finishGuestStop(vm, projectRoot, guestProvisioningToken(vm))
    if (!saved.ok) return saved
  }
  return halt
}

/** Destroy the slot container. Used only by explicit reset / delete. */
export async function destroySlot(vm, projectRoot) {
  await cancelGuestProvisioning(vm, projectRoot)
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('destroy')
  return slotHost(vm).destroy(vm, projectRoot)
}

/** Reload guest worker so a new bind-mounted / virtiofs binary is picked up. Never docker rm. */
export async function reloadSlot(vm, projectRoot, opts = {}) {
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('reload')
  return slotHost(vm).reload(vm, projectRoot, opts)
}

export async function reloadSlotReady(vm, projectRoot, opts = {}) {
  let token
  try {
    token = await beginGuestProvisioning(vm, projectRoot)
  } catch (error) {
    return { ok: false, code: error.code || 'guest_provisioning_invalid', error: error.message }
  }
  try {
    const boot = await reloadSlot(vm, projectRoot, opts)
    if (!boot?.ok) {
      await advanceGuestProvisioning(vm, projectRoot, token, opts.signal?.aborted ? 'cancelled' : 'failed', {
        errorCode: boot?.code || 'runtime_reload_failed',
      })
      return boot
    }
    if (!token) persistVmRuntime(projectRoot, vm.id, boot.runtime)
    return await attachInferenceRuntime(boot, vm, projectRoot, { ...opts, guestToken: token })
  } catch (error) {
    await advanceGuestProvisioning(vm, projectRoot, token, opts.signal?.aborted ? 'cancelled' : 'failed', {
      errorCode: error.code || 'runtime_reload_failed',
    })
    return { ok: false, code: error.code || 'runtime_reload_failed', error: error.message }
  }
}

/**
 * After Docker start/reload: if this slot resolves to rust and eager_start
 * is on, launch kin-kernel inside the container. Go-only slots skip.
 * Empty unused slots inherit rust from routing but must not bind a CONNECT
 * bridge or kernel.sock — that fights live wrap slots on host network.
 */
function slotHasCredential(vm, projectRoot) {
  if (vm?.has_token || vm?.claude?.has_access) return true
  if (!projectRoot || !vm?.id) return false
  const cred = path.join(projectRoot, 'vms', vm.id, 'cli-home', '.claude', 'credentials.json')
  try {
    return fs.statSync(cred).size > 8
  } catch {
    return false
  }
}

function wrapUsesSlotKernel(wrap) {
  return wrap?.ok === true && (wrap.glibc_shim === true || wrap.wrapper === true || wrap.kernel_bin === true)
}

export async function ensureSlotInferenceRuntime(vm, projectRoot, opts = {}) {
  const routing = opts.routing || {}
  const eager = routing?.inference?.eager_start !== false
  if (isCodexVm(vm)) {
    if (vm.guest_user && readCodexAccounts(projectRoot, vm.id).length === 0)
      return { ok: true, skipped: true, reason: 'no_credential', engine: 'codex' }
    if (!eager) return { ok: true, skipped: true, reason: 'eager_start_off', engine: 'codex' }
    const write = opts.ops?.writeCodexKernelConfig || writeCodexKernelConfig
    const start = opts.ops?.ensureCodexKernel || ensureCodexKernel
    const localExit = isLocalEgressProxy(vm?.proxy)
    write(projectRoot, vm, {
      proxyUrl: localExit ? '' : boundProxyUrl(vm?.proxy),
      proxyRequired: !localExit,
    })
    const kernel = await start(slotExec(projectRoot, vm), { timeoutMs: opts.timeoutMs })
    if (!kernel?.ok) {
      return {
        ok: false,
        code: kernel?.reason || 'codex_kernel_start_failed',
        error: kernel?.error || kernel?.reason || 'Codex kernel failed to start',
        engine: 'codex',
        kernel,
      }
    }
    return { ok: true, engine: 'codex', kernel }
  }
  if (!eager) return { ok: true, skipped: true, reason: 'eager_start_off' }
  const engine = resolveInferenceEngine(vm, routing)
  if (engine !== 'rust') return { ok: true, skipped: true, reason: 'engine_not_rust', engine }
  if (!slotHasCredential(vm, projectRoot)) {
    return { ok: true, skipped: true, reason: 'no_credential', engine: 'rust' }
  }
  if (runtimeKind(vm) === RUNTIME_KVM) return kvmRefuse('ensure-rust')
  // A baked slot image ships kernel and CLIs; there is no .kin to materialize or kernel to mount.
  if (!slotHost(vm).bakedKernel) {
    const dest = wrapCliHomeDir(projectRoot, vm.id)
    let wrap = inspectWrapCliDir(dest)
    if (!wrap?.ok) {
      wrap = (opts.ops?.materializeWrapCli || materializeWrapCli)(projectRoot, vm)
    }
    if (!wrap?.ok) {
      return {
        ok: false,
        code: wrap?.code || 'wrap_cli_missing',
        error: wrap?.error || 'wrap CLI is not installed in the slot home',
      }
    }
    if (!wrapUsesSlotKernel(wrap)) {
      const kernelBin = (opts.ops?.kernelBinPath || kernelBinPath)()
      const binaryError = kernelBinaryError(kernelBin)
      if (binaryError) return binaryError
      const name = containerName(vm.id)
      const hasMount = (opts.ops?.containerHasKernelMount || containerHasKernelMount)(name)
      if (!hasMount) {
        return {
          ok: false,
          code: 'kernel_mount_missing',
          error: 'Rust kernel binary is not mounted in the slot container',
        }
      }
    }
  }

  const exec = slotExec(projectRoot, vm)
  const start = opts.ops?.ensureRustKernel || ensureRustKernel
  const rust = await start(exec, { timeoutMs: opts.timeoutMs })
  if (!rust?.ok) {
    return {
      ok: false,
      code: rust?.reason === 'health_timeout' ? 'kernel_health_timeout' : 'kernel_start_failed',
      error: rust?.error || rust?.reason || 'Rust kernel failed to start',
      rust,
    }
  }
  return { ok: true, engine: 'rust', rust }
}

async function cancelOwnedGuestBoot(boot, vm, projectRoot, opts) {
  const token = opts.guestToken
  const cancelled = await advanceGuestProvisioning(vm, projectRoot, token, 'cancelled')
  if (cancelled?.ok && ['created', 'started'].includes(boot.action)) {
    const halt = await slotHost(vm).stop(vm, projectRoot)
    if (halt?.ok) await finishGuestStop(vm, projectRoot, guestProvisioningToken(vm))
  }
  return { ok: false, code: 'cancelled', error: 'Guest operation was cancelled' }
}

async function attachInferenceRuntime(boot, vm, projectRoot, opts = {}) {
  const token = opts.guestToken
  if (token && opts.signal?.aborted) return cancelOwnedGuestBoot(boot, vm, projectRoot, opts)
  if (token) {
    const current = await advanceGuestProvisioning(vm, projectRoot, token, 'provisioning_user', {
      runtime: boot.runtime,
    })
    if (!current.ok) return current
    const identity = await collectSlotIdentity(projectRoot, vm, { timeoutMs: opts.timeoutMs || 5000 })
    if (opts.signal?.aborted) return cancelOwnedGuestBoot(boot, vm, projectRoot, opts)
    if (!identity.ok) {
      await advanceGuestProvisioning(vm, projectRoot, token, 'failed', {
        errorCode: identity.code || 'guest_identity_mismatch',
      })
      return identity
    }
    const os = await advanceGuestProvisioning(vm, projectRoot, token, 'os_ready')
    if (!os.ok) return os
  }
  const rust = await ensureSlotInferenceRuntime(vm, projectRoot, opts)
  const codex = isCodexVm(vm)
  const engine = codex ? 'codex' : resolveInferenceEngine(vm, opts.routing || {})
  if (vm.runtime && typeof vm.runtime === 'object') vm.runtime.worker = engine
  if (token && opts.signal?.aborted) return cancelOwnedGuestBoot(boot, vm, projectRoot, opts)
  if (token && !rust?.skipped && rust?.ok) {
    const verifying = await advanceGuestProvisioning(vm, projectRoot, token, 'verifying_worker')
    if (!verifying.ok) return verifying
    const health = await (codex ? codexKernelHealth : rustKernelHealth)(slotExec(projectRoot, vm), {
      timeoutMs: opts.timeoutMs || 5000,
    })
    if (opts.signal?.aborted) return cancelOwnedGuestBoot(boot, vm, projectRoot, opts)
    const ready =
      health?.ok === true &&
      (codex
        ? health.engine === 'codex' && health.accounts > 0 && health.proxy_ok === true
        : health.engine === 'rust' &&
          health.provider === 'local_cli' &&
          health.healthy === true &&
          health.cli_pid > 0 &&
          health.ready_slots > 0)
    const verified = await advanceGuestProvisioning(vm, projectRoot, token, ready ? 'slot_ready' : 'failed', {
      errorCode: ready ? null : 'guest_worker_not_ready',
    })
    if (!verified.ok) return verified
    if (!ready)
      return {
        ok: false,
        code: 'guest_worker_not_ready',
        error: 'Native guest worker did not satisfy the readiness contract',
      }
  }
  if (token && rust?.ok === false) {
    await advanceGuestProvisioning(vm, projectRoot, token, 'failed', { errorCode: rust.code || 'guest_worker_failed' })
    return rust
  }
  if (codex) return { ok: true, engine: 'codex', docker: boot, kernel: rust, runtime: vm.runtime }
  return { ...boot, runtime: vm.runtime, rust, rust_ok: rust?.ok !== false || rust?.skipped === true }
}

export function slotExec(projectRoot, vm) {
  if (!projectRoot || !vm?.id) return null
  return {
    vmId: vm.id,
    accountId: vm.claude?.account_uuid || vm.id,
    vm,
    vmPath: path.join(projectRoot, 'vms', `${vm.id}.json`),
    homeDir: path.join(projectRoot, 'vms', vm.id, 'cli-home'),
    timezone: vm.timezone || 'UTC',
    locale: vm.locale || 'en_US.UTF-8',
    kernel: vm.kernel || null,
  }
}

function kernelBinaryError(bin) {
  if (!bin || !fs.existsSync(bin)) {
    return { ok: false, code: 'kernel_binary_missing', error: 'Rust kernel binary is not configured' }
  }
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return null
  } catch {
    return { ok: false, code: 'kernel_binary_not_executable', error: `Rust kernel binary is not executable: ${bin}` }
  }
}

/**
 * Reconcile one slot's actual in-container inference runtime. Persistence is
 * deliberately left to the caller so configuration is committed only after
 * the target runtime is healthy.
 */
export async function switchSlotInferenceEngine(vm, projectRoot, engine, { timeoutMs = 8000, ops = {} } = {}) {
  if (!vm?.id || !projectRoot) return { ok: false, code: 'vm_required', error: 'vm required' }
  if (!slotHost(vm).supports('engine_switch')) return unsupportedOnHost('engine_switch')
  if (isCodexVm(vm)) {
    return { ok: false, code: 'gpt_engine_forbidden', error: 'GPT slots do not use rust inference engines' }
  }
  if (engine === 'go') {
    return { ok: false, code: 'go_engine_disabled', error: 'Go HTTP forwarding is disabled' }
  }
  if (engine !== 'rust') {
    return { ok: false, code: 'invalid_inference_engine', error: 'inference engine must be rust' }
  }

  const inspect = ops.inspectContainer || inspectContainer
  const hasKernelMount = ops.containerHasKernelMount || containerHasKernelMount
  const start = ops.startVmRuntime || startVmRuntime
  const reload = ops.reloadSlotWorker || reloadSlotWorker
  const ensureRust = ops.ensureRustKernel || ensureRustKernel
  const kernelBin = (ops.kernelBinPath || kernelBinPath)()
  let wrap = null
  if (engine === 'rust') {
    wrap = (ops.materializeWrapCli || materializeWrapCli)(projectRoot, vm)
    if (!wrap?.ok) {
      return {
        ok: false,
        code: wrap?.code || 'wrap_cli_missing',
        error: wrap?.error || 'wrap CLI is not installed in the slot home',
      }
    }
    if (!wrapUsesSlotKernel(wrap)) {
      const binaryError = kernelBinaryError(kernelBin)
      if (binaryError) return binaryError
    }
    const writeConfig = ops.writeKernelConfig || writeKernelConfig
    writeConfig(projectRoot, vm, { routing: ops.routing })
  }

  const name = containerName(vm.id)
  const existing = inspect(name)
  const needsKernelMount = engine === 'rust' && !!existing && !hasKernelMount(name) && !wrapUsesSlotKernel(wrap)
  const boot = await (needsKernelMount ? start(vm, projectRoot, { recreate: true }) : reload(vm, projectRoot))
  if (!boot?.ok) {
    return {
      ok: false,
      code: needsKernelMount ? 'kernel_mount_failed' : 'vm_runtime_failed',
      error: boot?.error || 'slot runtime failed',
    }
  }
  if (engine === 'rust' && !hasKernelMount(name) && !wrapUsesSlotKernel(wrap)) {
    return { ok: false, code: 'kernel_mount_missing', error: 'Rust kernel binary is not mounted in the slot container' }
  }

  const exec = slotExec(projectRoot, vm)
  const startRust = wrapUsesSlotKernel(wrap) ? ops.restartRustKernel || restartRustKernel : ensureRust
  const rust = await startRust(exec, { timeoutMs })
  if (!rust?.ok) {
    const code = rust?.reason === 'health_timeout' ? 'kernel_health_timeout' : 'kernel_start_failed'
    const rollback = await reload(vm, projectRoot)
    return {
      ok: false,
      code,
      error: rust?.error || rust?.reason || 'Rust kernel failed to start',
      rollback,
      runtime: {
        rust: { reachable: false, health: rust?.health || null },
      },
    }
  }
  return {
    ok: true,
    active_engine: 'rust',
    action: boot.action,
    runtime: {
      rust: { reachable: true, health: rust.health || null },
    },
  }
}

async function rollbackInferenceEngines(switched, projectRoot, engine, switchEngine) {
  const rollbacks = []
  for (let i = switched.length - 1; i >= 0; i -= 1) {
    const item = switched[i]
    rollbacks.push({ id: item.vm.id, result: await switchEngine(item.vm, projectRoot, engine) })
  }
  return rollbacks
}

/** Switch only VMs that inherit the global inference engine. */
export async function switchInheritedInferenceEngines({
  projectRoot,
  previousEngine,
  targetEngine,
  switchEngine = switchSlotInferenceEngine,
  commit = null,
}) {
  const inherited = listVms(projectRoot)
    .map(({ id }) => getVm(projectRoot, id))
    .filter(
      (vm) =>
        vm &&
        !isCodexVm(vm) &&
        slotHost(vm).supports('engine_switch') &&
        !Object.prototype.hasOwnProperty.call(vm, 'inference_engine'),
    )
  const switched = []
  for (const vm of inherited) {
    const result = await switchEngine(vm, projectRoot, targetEngine)
    if (result.ok) {
      switched.push({ vm, result })
      continue
    }
    return {
      ok: false,
      changed: true,
      code: result.code || 'default_engine_switch_failed',
      error: result.error || `failed to switch ${vm.id} to ${targetEngine}`,
      failed_vm: vm.id,
      rollbacks: await rollbackInferenceEngines(switched, projectRoot, previousEngine, switchEngine),
    }
  }
  const runtime = {
    ok: true,
    changed: true,
    previous_engine: previousEngine,
    target_engine: targetEngine,
    items: switched.map(({ vm, result }) => ({ id: vm.id, active_engine: result.active_engine })),
  }
  if (!commit) return runtime
  try {
    return { ...runtime, applied: await commit() }
  } catch (error) {
    return {
      ok: false,
      changed: true,
      code: 'routing_persist_failed',
      error: String(error?.message || error),
      rollbacks: await rollbackInferenceEngines(switched, projectRoot, previousEngine, switchEngine),
    }
  }
}
