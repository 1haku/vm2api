import fs from 'node:fs'
import path from 'node:path'
import { startJsonKeepalive, stopJsonKeepalive } from '../http/json-keepalive.mjs'

let active = 0

// A no-inference diagnostic for the actual proxy path. Disabled unless a local
// operator creates this short-lived file; the panel route also requires admin.
export async function runJsonKeepaliveProbe(req, res, { dataDir, json, scenario }) {
  let enabled = false
  try {
    const file = path.join(dataDir, 'run', 'json-keepalive-probe.json')
    const stat = fs.lstatSync(file)
    if (stat.isFile() && stat.size < 1024) {
      const until = JSON.parse(fs.readFileSync(file, 'utf8')).enabled_until
      enabled = Number.isFinite(until) && until > Date.now() && until <= Date.now() + 15 * 60_000
    }
  } catch {}
  if (!enabled) return json(res, 404, { error: { message: 'Not found' } })
  if (!['success', 'baseline', 'early-error', 'late-error', 'timeout'].includes(scenario)) {
    return json(res, 400, { error: { message: 'Unknown diagnostic scenario' } })
  }
  if (active >= 2) return json(res, 429, { error: { message: 'Diagnostic busy' } })
  active++
  let timer
  let done
  try {
    if (scenario !== 'baseline') {
      startJsonKeepalive(req, res, {
        delayMs: 30_000,
        intervalMs: 10_000,
        maxDurationMs: scenario === 'timeout' ? 35_000 : 180_000,
      })
    }
    if (scenario === 'early-error') return json(res, 503, { error: { message: 'Simulated early error' } })
    const elapsed = await new Promise((resolve) => {
      done = () => resolve(false)
      res.once('close', done)
      timer = setTimeout(() => resolve(true), scenario === 'late-error' ? 35_000 : 150_000)
      timer.unref?.()
    })
    if (!elapsed || res.destroyed) return
    if (scenario === 'late-error') return json(res, 503, { error: { message: 'Simulated late error' } })
    return json(res, 200, { ok: true, simulated: true, elapsed_ms: 150_000, inference_calls: 0 })
  } finally {
    active--
    clearTimeout(timer)
    if (done) res.off('close', done)
    stopJsonKeepalive(res)
  }
}
