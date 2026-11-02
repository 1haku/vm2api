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
}) {
  const identities = new Map()
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
  // Full OAuth imports may have credentials but no account metadata. Resolve
  // identity from the official profile without changing the slot's quota key.
  // A rotating credential fingerprint only invalidates this short-lived cache;
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
      cached = identities.get(id)
    if (fingerprint && cached?.fingerprint === fingerprint && Date.now() - cached.at < 60000) return cached.key
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
    identities.set(id, { fingerprint, key, at: Date.now() })
    return key
  }
  async function sample(id, { credits = false } = {}) {
    const vm = getVm(projectRoot, id),
      account = await identity(id)
    if (!vm || !account) return null
    let result,
      window,
      credit = null
    const codex = isCodexVm(vm)
    if (codex) {
      result = await queryOpenaiQuota({ projectRoot, vmId: id, policy: getRouting().codex?.quota })
      window = { utilization: result.quota?.utilization_7d, resets_at: result.quota?.reset_7d }
      credit = result.warning ? null : result.reset_credits
    } else {
      if (!canOfficialUsage(credentialModeOfVm(vm))) return null
      result = await probeVmUsage({
        exec: { vmId: id, homeDir: path.join(projectRoot, 'vms', id, 'cli-home'), oauth: vm.claude, vm },
        includeFable: false,
      })
      if ((await identity(id)) !== account) return null
      if (result.ok && !result.rate_limited) accountQuota?.ingestOAuthUsage(vm.claude?.account_uuid || id, result)
      window = result.seven_day
      if (result.ok && (credits || window?.utilization >= 0.9)) {
        const queried = await queryClaudeResetCredits({ projectRoot, vmId: id })
        if (queried.ok) credit = queried.claude_reset_credits
      }
    }
    if (!result.ok || result.rate_limited || (await identity(id)) !== account) return null
    const used = window?.utilization,
      end = Date.parse(window?.resets_at)
    if (used == null || !Number.isFinite(used) || used < 0 || used > 1 || !Number.isFinite(end) || end <= Date.now())
      return null
    const current = getVm(projectRoot, id)
    return {
      id,
      account,
      name: vm.display_name || vm.name || id,
      provider: codex ? 'Codex' : 'Claude',
      used: used * 100,
      end,
      at: Date.now(),
      resetAt: codex ? current.codex?.subscription_weekly?.resetAt || 0 : 0,
      credits: weeklyCreditView(codex ? 'Codex' : 'Claude', credit),
    }
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
    redeem,
    list: () =>
      listVms(projectRoot)
        .filter((v) => v.has_token)
        .map((v) => v.id),
  }
}
