import { SubscriptionsRepo, subscriptionError } from '../db/repos/subscriptions-repo.mjs'
import { detectInboundPlatform } from '../protocol/platform-detect.mjs'
import { isUpstreamRefusal } from '../core/refusal-guard.mjs'

// Server-owned state: never inferred from caller headers or body flags.
export const subscriptionRoute = Symbol('subscriptionRoute')

export function subscriptionApiOptions(sub) {
  return {
    groupType: sub.group.platform === 'openai' ? 'openai' : 'anthropic',
    endpointBindings: sub.apiEndpoints,
    allowedModels: JSON.parse(sub.group.resource_models || '[]'),
  }
}

export function selectSubscriptionResource(req, db, scheduler, model, { forceApi = false } = {}) {
  const sub = req.apiKeyRecord && db ? new SubscriptionsRepo(db).entitlement(req.apiKeyRecord) : null
  if (!sub) return null
  const options = subscriptionApiOptions(sub)
  if (options.allowedModels.length && !options.allowedModels.includes(model))
    throw subscriptionError('此模型不在套餐授权范围内', 403, 'subscription_model_forbidden')
  const platform = detectInboundPlatform(model)
  const slotModel =
    sub.vmIds.length > 0 &&
    (!sub.apiEndpoints.length || (platform.ok && platform.platform === options.groupType) || /^gpt-image-/i.test(model))
  const endpointPrefix =
    String(model || '').includes('/') && scheduler.catalog(options).data.some((m) => m.id === model)
  const useApi = forceApi || endpointPrefix || !slotModel || sub.group.resource_preference === 'api_first'
  if (useApi) {
    const picked = scheduler.pick(model, Date.now(), options)
    if (picked.ok) return (req[subscriptionRoute] = { sub, backend: 'api', picked, model })
    if (forceApi || !slotModel)
      throw subscriptionError(picked.message, picked.code === 'model_not_found' ? 404 : 503, picked.code)
  }
  return (req[subscriptionRoute] = { sub, backend: 'oauth', model })
}

export function canFallbackToSubscriptionApi(req, res, result, usage) {
  const route = req[subscriptionRoute]
  if (!route || route.backend !== 'oauth' || !route.sub.group.api_fallback || !route.sub.apiEndpoints.length)
    return false
  if (req.aborted || res.destroyed || res.headersSent || res.writableEnded || result?.committed || result?.responseSent)
    return false
  if (isUpstreamRefusal(result) || result?.policy?.rememberRefusal) return false
  const code = String(result?.body?.error?.code || result?.error?.code || result?.code || '')
  if (
    result?.clusterDeliveryUnconfirmed === true ||
    ['cluster_delivery_unconfirmed', 'cluster_slot_reconnecting'].includes(code) ||
    (result?.nativeHandoff === true && /^native_handoff_(missing|invalid|conflict|incomplete)$/.test(code))
  )
    return false
  // Never route around policy, identity, client admission, or quota restrictions.
  if (
    /refusal|policy|guard|permission|forbidden|subscription|concurrency|rpm|invalid|client|cancel|abort|mismatch|not_allowed|not_portable|vm_pool_unavailable/i.test(
      code,
    )
  )
    return false
  if (![429, 500, 502, 503, 504].includes(result?.status)) return false
  const hasUsage = (value) =>
    value &&
    typeof value === 'object' &&
    Object.entries(value).some(([k, v]) =>
      typeof v === 'object' ? hasUsage(v) : /token|cost|requests/.test(k) && Number(v) > 0,
    )
  if ([usage, result?.usage, result?.body?.usage].some(hasUsage)) return false
  if (result?.body?.output?.length || result?.body?.content?.length) return false
  return true
}
