/**
 * Host watchdog for rust PID-1 slots. Restarts the container via
 * ensureRustKernel; never falls back to kin-worker hop.
 */
import { rustKernelHealth, rustKernelReachable, rustKernelBusy, rustKernelPaths } from './rust-kernel-client.mjs'
import { ensureRustKernel, readExistingKernelConfig, WRAP_SLOT_MAX } from './rust-kernel-supervisor.mjs'
import { normalizeInferenceEngine } from '../vm/slot-engine.mjs'

export const DEFAULT_KERNEL_WATCHDOG = Object.freeze({
  enabled: true,
  interval_sec: 20,
  timeout_ms: 15_000,
})

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeKernelWatchdogConfig(raw = {}) {
  return {
    enabled: raw.enabled !== false,
    interval_sec: clampInt(raw.interval_sec, 5, 300, DEFAULT_KERNEL_WATCHDOG.interval_sec),
    timeout_ms: clampInt(raw.timeout_ms, 3000, 60_000, DEFAULT_KERNEL_WATCHDOG.timeout_ms),
  }
}

const HARD_DOWN = new Set(['stopped', 'dead', 'error', 'disabled'])

export function isKernelWatchdogTarget(vm) {
  if (!vm?.id) return false
  if (vm.runtime_kind === 'kvm') return false
  if (HARD_DOWN.has(String(vm.status || '').toLowerCase())) return false
  const configured = normalizeInferenceEngine(vm.inference_engine, { inherit: true })
  if (configured === 'rust') return true
  return String(vm.runtime?.engine || '').toLowerCase() === 'rust'
}

function kernelSlotMismatch(exec) {
  const configPath = rustKernelPaths(exec).configPath
  if (!configPath) return false
  const n = Number(readExistingKernelConfig(configPath).slots_per_worker)
  return Number.isFinite(n) && n !== WRAP_SLOT_MAX
}

export function createKernelWatchdog({
  config: initial = {},
  listTargets,
  homeDirFor,
  ensure = ensureRustKernel,
  health = rustKernelHealth,
} = {}) {
  let config = normalizeKernelWatchdogConfig(initial)
  let timer = null
  let running = false
  let inTick = false

  async function tick() {
    if (inTick || !config.enabled) return
    inTick = true
    try {
      const vms = typeof listTargets === 'function' ? listTargets() || [] : []
      for (const vm of vms) {
        if (!isKernelWatchdogTarget(vm)) continue
        const exec = {
          vmId: vm.id,
          vm,
          homeDir: typeof homeDirFor === 'function' ? homeDirFor(vm) : null,
        }
        const current = await health(exec, { timeoutMs: 800 })
        if (rustKernelBusy(current)) continue
        if (rustKernelReachable(current) && !kernelSlotMismatch(exec)) continue
        await ensure(exec, { timeoutMs: config.timeout_ms })
      }
    } finally {
      inTick = false
    }
  }

  return {
    setConfig(next) {
      config = normalizeKernelWatchdogConfig(next || {})
    },
    start({ immediate = true } = {}) {
      if (running) return
      running = true
      if (immediate) void tick()
      timer = setInterval(() => void tick(), config.interval_sec * 1000)
      timer.unref?.()
    },
    stop() {
      running = false
      if (timer) clearInterval(timer)
      timer = null
    },
    tick,
  }
}
