// Official account totals only. Never issue a billable inference health probe.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getVm, listVms } from '../vm/vm-registry.mjs'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { readCodexAccounts } from '../vm/codex-slot.mjs'
import { codexWeeklyAccountKey } from '../protocol/codex-weekly-reset.mjs'
import { canOfficialUsage, credentialModeOfVm } from '../oauth/credential-mode.mjs'
import { probeVmUsage } from '../oauth/crs-usage-probe.mjs'
import { queryOpenaiQuota, resetOpenaiQuota } from '../oauth/openai-quota.mjs'
import { queryClaudeResetCredits, redeemClaudeResetCredit } from '../oauth/claude-reset-credits.mjs'
import { runSlotOauth } from '../transport/slot-oauth.mjs'
import { officialWindow, parseResetMs } from '../pool/quota-window.mjs'
import { normalizeNotifyConfig } from './notify.mjs'

export function weeklyCreditView(provider, credits, now = Date.now()) {
  if (!credits || !Number.isFinite(Date.parse(credits.fetched_at)) || now - Date.parse(credits.fetched_at) > 120000)
    return { known: false, held: 0, available: 0 }
  const alive = (c) => !c.expires_at || Date.parse(c.expires_at) > now
  if (provider === 'Claude') {
    const weekly = (credits.credits || []).filter((c) => c.clears?.includes('seven_day') && alive(c))
    return {
      known: true,
      held: weekly.reduce((n, c) => n + c.resets_left, 0),
      available: weekly.filter((c) => c.redeemable).reduce((n, c) => n + c.resets_left, 0),
    }
  }
  const count = Math.max(
    0,
    Math.min(Number(credits.available_count) || 0, (credits.credits || []).filter(alive).length),
  )
  return { known: true, held: count, available: count }
}

export function createWeeklyQuotaSource({
  projectRoot,
  accountQuota,
  getRouting = () => ({}),
  identityTransport = runSlotOauth,
  refreshQuota = null,
  store = null,
  now = Date.now,
  queryCredits = queryClaudeResetCredits,
}) {
  const identities = new Map()
  const flights = new Map(),
    retryAfter = new Map(),
    identityRetry = new Map()
  const metrics = { cache_hits: 0, refreshes: 0, backoff_skips: 0, credit_queries: 0, identity_queries: 0 }
  const maxAge = () => normalizeNotifyConfig(getRouting().notify).weekly_quota_interval_sec * 1000
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
  // Full OAuth imports may have credentials but no account metadata. Resolve
  // identity from the official profile without changing the slot's quota key.
  // A rotating credential fingerprint invalidates the persisted identity cache;
  // alert deduplication remains keyed by stable official account + organization.
  function credentialFingerprint(id) {
    try {
      return sha(fs.readFileSync(path.join(projectRoot, 'vms', id, 'cli-home', '.claude', 'credentials.json')))
    } catch {
      return null
    }
  }
  async function identity(id) {
    let vm
    try {
      vm = getVm(projectRoot, id)
    } catch {
      return null
    }
    if (!vm) return null
    if (isCodexVm(vm)) {
      const key = codexWeeklyAccountKey(vm, readCodexAccounts(projectRoot, id)[0])
      return key ? sha(`Codex:${key}`) : null
    }
    if (!canOfficialUsage(credentialModeOfVm(vm))) return null
    const fingerprint = credentialFingerprint(id),
      cached = identities.get(id) || store?.get(`identity:${id}`)
    if (fingerprint && cached?.fingerprint === fingerprint) {
      identities.set(id, cached)
      return cached.key
    }
    if (now() < (identityRetry.get(id) || 0)) return null
    identityRetry.set(id, now() + 60000)
    metrics.identity_queries++
    const profile = await identityTransport(
      { vmId: id, homeDir: path.join(projectRoot, 'vms', id, 'cli-home'), oauth: vm.claude, vm },
      'profile',
      { timeoutMs: 20000 },
    )
    const account = profile.body?.account?.uuid,
      org = profile.body?.organization?.uuid
    if (!profile.ok || profile.status !== 200 || !account || !org || credentialFingerprint(id) !== fingerprint)
      return null
    const key = sha(`Claude:${account}:${org}`)
    // A slot can be reused for another account while its old quota row remains.
    // Bind snapshots only after the first identity check / account replacement.
    const binding = { fingerprint, key, at: now(), since: cached?.key === key ? cached.since : now() }
    identities.set(id, binding)
    identityRetry.delete(id)
    store?.set(`identity:${id}`, binding)
    return key
  }
  function cachedSample(id, account) {
    const vm = getVm(projectRoot, id)
    if (!vm) return null
    const codex = isCodexVm(vm)
    let used,
      end,
      at,
      resetAt = 0
    if (codex) {
      const tracked = vm.codex?.subscription_weekly
      if (!tracked || tracked.account !== codexWeeklyAccountKey(vm, readCodexAccounts(projectRoot, id)[0])) return null
      if (sha(`Codex:${tracked.account}`) !== account) return null
      ;({ used, end, at, resetAt = 0 } = tracked)
    } else {
      const acc = accountQuota?.repo.get(vm.claude?.account_uuid || id)
      const window = officialWindow(acc?.unified || {}, '7d')
      used = window.utilization == null ? null : window.utilization * 100
      end = parseResetMs(window.reset)
      // Only the successful official probe dates this sample. Messages/Extra
      // headers and unrelated account edits must not make old totals fresh.
      const written = Date.parse(acc?.unified?.official?.updated_at || acc?.last_probe?.at)
      const probed = Date.parse(acc?.last_probe?.at)
      at = Number.isFinite(probed) ? Math.min(written, probed) : written
      const binding = identities.get(id)
      if (
        !binding ||
        binding.key !== account ||
        binding.fingerprint !== credentialFingerprint(id) ||
        at < binding.since
      )
        return null
    }
    if (
      used == null ||
      !Number.isFinite(used) ||
      used < 0 ||
      used > 100 ||
      !Number.isFinite(end) ||
      end <= now() ||
      !Number.isFinite(at) ||
      at > now() + 60000 ||
      at < now() - maxAge()
    )
      return null
    // Cards predating a newer quota observation are rechecked before offering a reset.
    const credit = codex ? vm.codex?.reset_credits : vm.claude_reset_credits
    const creditAt = Date.parse(credit?.fetched_at)
    return {
      id,
      account,
      name: vm.display_name || vm.name || id,
      provider: codex ? 'Codex' : 'Claude',
      used,
      end,
      at,
      resetAt,
      credits: weeklyCreditView(codex ? 'Codex' : 'Claude', creditAt >= at ? credit : null, now()),
    }
  }
  async function refresh(id, account) {
    if (flights.has(id)) return flights.get(id)
    const vm = getVm(projectRoot, id)
    const acc = accountQuota?.repo.get(vm.claude?.account_uuid || id)
    const blockedUntil = Date.parse(acc?.unified?.usage_rate_limited_until || '')
    if (now() < (retryAfter.get(account) || 0) || now() < blockedUntil) {
      metrics.backoff_skips++
      return false
    }
    // Failed/missing probes cannot turn the local 15-second scan into a retry storm.
    retryAfter.set(account, now() + 60000)
    const before = cachedSample(id, account)
    const job = (async () => {
      metrics.refreshes++
      if (refreshQuota) await refreshQuota(id)
      else if (isCodexVm(vm)) await queryOpenaiQuota({ projectRoot, vmId: id, policy: getRouting().codex?.quota })
      else {
        const result = await probeVmUsage({
          exec: { vmId: id, homeDir: path.join(projectRoot, 'vms', id, 'cli-home'), oauth: vm.claude, vm },
          includeFable: false,
        })
        if ((await identity(id)) === account) accountQuota?.ingestOAuthUsage(vm.claude?.account_uuid || id, result)
      }
      if ((await identity(id)) !== account) return false
      const fresh = cachedSample(id, account)
      if (!fresh || (before && fresh.at <= before.at)) return false
      retryAfter.delete(account)
      return true
    })().finally(() => flights.delete(id))
    flights.set(id, job)
    return job
  }
  async function sample(id, { force = false, credits = false } = {}) {
    const account = await identity(id)
    if (!account) return null
    let result = cachedSample(id, account)
    if (!force && result) metrics.cache_hits++
    else {
      if (!(await refresh(id, account))) return null
      result = cachedSample(id, account)
    }
    if (!result) return null
    return credits ? prepareNotification(result) : result
  }
  async function prepareNotification(snapshot) {
    if ((await identity(snapshot.id)) !== snapshot.account) return null
    let result = cachedSample(snapshot.id, snapshot.account)
    if (!result) return null
    if (result.credits.known) return result
    metrics.credit_queries++
    if (result.provider === 'Claude') {
      // A card endpoint failure must not suppress an otherwise valid quota alert.
      const queried = await queryCredits({ projectRoot, vmId: result.id }).catch(() => null)
      if ((await identity(result.id)) !== result.account) return null
      result.credits = weeklyCreditView('Claude', queried?.ok ? queried.claude_reset_credits : null, now())
    } else {
      // The existing Codex quota endpoint fetches cards together with usage.
      // Only refresh it when a notification actually needs fresh card data.
      try {
        if (await refresh(result.id, result.account)) result = cachedSample(result.id, result.account) || result
      } catch {}
      if ((await identity(result.id)) !== result.account) return null
    }
    return result
  }
  async function redeem(snapshot, operation) {
    if ((await identity(snapshot.id)) !== snapshot.account) throw new Error('account_changed')
    if (snapshot.provider === 'Claude') {
      const r = await redeemClaudeResetCredit({
        projectRoot,
        vmId: snapshot.id,
        idempotencyKey: operation,
        requiredWindow: 'seven_day',
      })
      return { confirmed: r.ok && r.outcome === 'reset' && r.cleared?.includes('seven_day'), result: r }
    }
    const r = await resetOpenaiQuota({ projectRoot, vmId: snapshot.id, policy: getRouting().codex?.quota })
    return { confirmed: r.ok && r.windows_reset >= 2 && r.quota?.utilization_7d === 0, result: r }
  }
  return {
    identity,
    sample,
    prepareNotification,
    getStatus: () => ({ ...metrics }),
    redeem,
    list: () =>
      listVms(projectRoot)
        .filter((v) => v.has_token)
        .map((v) => v.id),
  }
}
