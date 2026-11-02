import crypto from 'node:crypto'
import { normalizeNotifyConfig, telegramRequest } from './notify.mjs'

const DAY = 86400000
export const WEEKLY_THRESHOLDS = [10, 5, 3, 1, 0]
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest('hex')
const recipientKey = (c) => hash(JSON.stringify([c.telegram.bot_token, c.telegram.chat_id]))
const enabled = (c) =>
  c.enabled && c.telegram.enabled && c.weekly_quota_enabled && c.telegram.bot_token && c.telegram.chat_id
const privateChat = (c) => /^[1-9]\d*$/.test(c.telegram.chat_id)
export function weeklyThreshold(used) {
  if (used == null || !Number.isFinite(used) || used < 0 || used > 100) return null
  return WEEKLY_THRESHOLDS.filter((t) => 100 - used <= t + 1e-8).at(-1) ?? null
}
export function weeklyMessage(s) {
  const credits = s.credits || {}
  const card = !credits.known
    ? '未能确认（本次不提供重置按钮）'
    : `持有 ${credits.held} 张，当前可用 ${credits.available} 张${credits.held && !credits.available ? '（尚未满足官方使用条件）' : ''}`
  const reset = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Tokyo',
    dateStyle: 'medium',
    timeStyle: 'long',
  }).format(new Date(s.end))
  return [
    `${s.provider} 官方周额度${s.used >= 100 ? '已耗尽' : '提醒'}`,
    `槽位：${String(s.name).slice(0, 120)}`,
    `剩余：${Math.max(0, 100 - s.used).toFixed(2)}%（已用 ${s.used.toFixed(2)}%）`,
    `下次周期更新：${reset}（UTC+09:00）`,
    `官方重置卡：${card}`,
    credits.available ? '按钮消耗 1 张官方卡。官方可能同时重置短周期；结果以官方回执及新快照为准。' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function weeklyNotifyStore(getDb) {
  return {
    get(key) {
      const row = getDb().prepare('SELECT data FROM custom_weekly_quota_notify WHERE key=?').get(key)
      return row ? JSON.parse(row.data) : null
    },
    set(key, data, expires = Date.now() + 30 * DAY) {
      getDb()
        .prepare(
          'INSERT INTO custom_weekly_quota_notify(key,data,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at',
        )
        .run(key, JSON.stringify(data), expires)
    },
    prune(now) {
      getDb().prepare('DELETE FROM custom_weekly_quota_notify WHERE expires_at<?').run(now)
    },
  }
}

// One monitor owns polling. Durable actions are claimed BEFORE any redeem I/O;
// interrupted/uncertain claims cannot be replayed, even through another message.
export function createWeeklyQuotaNotify({ getConfig, store, source, request = telegramRequest, now = Date.now }) {
  let running = false,
    timer = null,
    pollTimer = null,
    controller = new AbortController()
  let checkJob = null,
    pollJob = null,
    callbackJob = null,
    verified = null
  let lastRun = null,
    lastError = null,
    pollError = null,
    samples = []
  const config = () => normalizeNotifyConfig(getConfig())
  const send = (c, method, body, extra = {}) => request(c, method, body, { signal: controller.signal, ...extra })
  const status = () => ({
    enabled: !!enabled(config()),
    interval_sec: config().weekly_quota_interval_sec,
    thresholds: WEEKLY_THRESHOLDS,
    last_run_at: lastRun,
    last_error: lastError,
    callback_error: pollError,
    callbacks_ready: !!verified && verified.key === recipientKey(config()),
    slots: samples,
  })

  async function verify(c) {
    const key = recipientKey(c)
    if (verified?.key === key) return true
    if (!privateChat(c)) {
      pollError = '重置按钮仅支持绑定的 Telegram 私聊；群聊仍可接收额度提醒'
      return false
    }
    const hook = await send(c, 'getWebhookInfo', {})
    if (hook?.url) {
      pollError = '机器人已配置 webhook，未接管回调；请使用独立机器人'
      return false
    }
    const me = await send(c, 'getMe', {})
    if (!me?.is_bot || !me.id) throw new Error('telegram_bot_invalid')
    verified = { key, id: String(me.id) }
    pollError = null
    return true
  }
  function observe(s) {
    const key = `account:${s.account}`,
      old = store.get(key)
    let record = old || {
      cycle: crypto.randomUUID(),
      end: s.end,
      sent: 101,
      at: 0,
      used: s.used,
      resetAt: s.resetAt || 0,
    }
    if (s.at < record.at) return null
    const freshZero = old && s.at > record.at && s.used === 0 && (record.used > 0 || record.zeroAt)
    const early =
      old && ((s.resetAt && s.resetAt > record.resetAt) || (freshZero && record.zeroAt && s.at - record.zeroAt >= 5000))
    if (old && (s.at >= record.end || early)) {
      record = { cycle: crypto.randomUUID(), sent: 101, end: s.end, resetAt: s.resetAt || 0 }
    }
    record.zeroAt = freshZero && !early ? record.zeroAt || s.at : null
    record.end = s.end
    record.used = s.used
    record.at = s.at
    record.resetAt = s.resetAt || record.resetAt || 0
    store.set(key, record)
    return record
  }
  async function check() {
    const c = config()
    if (!enabled(c)) return
    lastRun = new Date(now()).toISOString()
    lastError = null
    samples = []
    store.prune(now())
    let buttons = false
    try {
      buttons = await verify(c)
    } catch {
      pollError = 'Telegram 回调连接失败，稍后自动重试'
    }
    const seen = new Set()
    for (const id of source.list()) {
      if (controller.signal.aborted || !enabled(config()) || recipientKey(config()) !== recipientKey(c)) break
      try {
        const s = await source.sample(id)
        if (
          !s ||
          !s.account ||
          !Number.isFinite(s.at) ||
          s.at < now() - 120000 ||
          s.at > now() + 60000 ||
          s.end <= now()
        ) {
          samples.push({ id, error: '官方周快照不可用，本次跳过' })
          continue
        }
        samples.push({
          id,
          used_percent: s.used,
          resets_at: new Date(s.end).toISOString(),
          checked_at: new Date(s.at).toISOString(),
        })
        if (seen.has(s.account)) continue
        seen.add(s.account)
        const state = observe(s),
          threshold = weeklyThreshold(s.used)
        if (!state || threshold == null || threshold >= state.sent) continue
        if (!enabled(config()) || recipientKey(config()) !== recipientKey(c) || controller.signal.aborted) break
        const token = crypto.randomBytes(18).toString('base64url'),
          actionKey = `action:${hash(token)}`
        const fence = store.get(`fence:${s.account}:${state.cycle}`)
        const canReset = buttons && s.credits?.available > 0 && !fence
        const action = {
          id,
          account: s.account,
          cycle: state.cycle,
          end: s.end,
          expires: s.end,
          recipient: recipientKey(c),
          status: 'sending',
          message: null,
          text: weeklyMessage(s),
        }
        if (canReset) store.set(actionKey, action, s.end + DAY)
        const reply = await send(c, 'sendMessage', {
          chat_id: c.telegram.chat_id,
          text: action.text,
          disable_web_page_preview: true,
          ...(canReset
            ? {
                reply_markup: {
                  inline_keyboard: [[{ text: '使用 1 张重置卡重置周额度', callback_data: `wq:${token}` }]],
                },
              }
            : {}),
        })
        if (!reply?.message_id) throw new Error('telegram_message_missing')
        if (canReset) store.set(actionKey, { ...action, message: reply.message_id, status: 'pending' }, s.end + DAY)
        // The callback may have updated the account while delivery was in flight.
        const latest = store.get(`account:${s.account}`)
        if (latest?.cycle === state.cycle)
          store.set(`account:${s.account}`, { ...latest, sent: Math.min(latest.sent, threshold) })
      } catch {
        lastError = '部分槽位查询或通知失败，将在下次检查重试'
        samples.push({ id, error: '查询或通知失败' })
      }
    }
  }
  const runOnce = () =>
    checkJob ||
    (checkJob = check().finally(() => {
      checkJob = null
    }))

  async function handle(q) {
    const c = config()
    const answer = (text) =>
      send(c, 'answerCallbackQuery', { callback_query_id: q.id, text, show_alert: true }).catch(() => {})
    const token = /^wq:([A-Za-z0-9_-]{24})$/.exec(q?.data || '')?.[1]
    if (!token) return
    if (
      !enabled(c) ||
      !privateChat(c) ||
      verified?.key !== recipientKey(c) ||
      String(q.from?.id) !== c.telegram.chat_id ||
      String(q.message?.chat?.id) !== c.telegram.chat_id ||
      q.message?.chat?.type !== 'private' ||
      String(q.message?.from?.id) !== verified.id
    ) {
      await answer('无权执行此操作')
      return
    }
    const key = `action:${hash(token)}`,
      action = store.get(key)
    if (
      !action ||
      action.recipient !== recipientKey(c) ||
      action.message !== q.message.message_id ||
      action.status !== 'pending' ||
      action.expires <= now()
    ) {
      await answer('按钮已失效或处理过，请查看最新通知')
      return
    }
    const state = store.get(`account:${action.account}`),
      fenceKey = `fence:${action.account}:${action.cycle}`
    if (state?.cycle !== action.cycle || store.get(fenceKey) || (await source.identity(action.id)) !== action.account) {
      await answer('账号或周期已改变，或已有一次重置正在处理')
      return
    }
    store.set(key, { ...action, status: 'checking' }, action.expires + DAY)
    await answer('正在核对官方额度和重置卡，请勿重复点击')
    let text = '未执行：官方额度或重置卡无法确认，请在控制台检查。'
    let claimed = false
    try {
      const fresh = await source.sample(action.id, { credits: true })
      if (
        !fresh ||
        fresh.account !== action.account ||
        Math.abs(fresh.end - action.end) > 60000 ||
        fresh.used < 90 ||
        fresh.at < now() - 120000 ||
        !fresh.credits?.available ||
        action.expires <= now() ||
        recipientKey(config()) !== action.recipient ||
        !enabled(config()) ||
        controller.signal.aborted ||
        (await source.identity(action.id)) !== action.account ||
        store.get(`account:${action.account}`)?.cycle !== action.cycle ||
        store.get(fenceKey)
      ) {
        text = '未执行：账号、周期、额度或卡片状态已变化。请查看最新控制台状态。'
      } else {
        // Persist the fence before the external mutation. A crash leaves it closed.
        store.set(fenceKey, { status: 'executing', at: now() }, now() + 30 * DAY)
        store.set(key, { ...action, status: 'executing' }, action.expires + DAY)
        claimed = true
        const result = await source.redeem(fresh, `telegram-weekly-${hash(token)}`)
        text = result.confirmed
          ? '官方已确认周额度重置成功。'
          : '官方未确认周额度重置完成；不会自动再次消耗重置卡，请在控制台核查。'
        store.set(fenceKey, { status: result.confirmed ? 'done' : 'uncertain', at: now() }, now() + 30 * DAY)
        if (result.confirmed) {
          const after = await source.sample(action.id)
          if (after?.account === action.account) {
            const next = {
              cycle: crypto.randomUUID(),
              end: after.end,
              sent: 101,
              at: after.at,
              used: after.used,
              resetAt: after.resetAt || 0,
            }
            store.set(`account:${after.account}`, next)
            text += '\n' + weeklyMessage(after)
          } else text += '\n最新周期暂未获取，请稍后查看控制台。'
        }
      }
    } catch {
      text = claimed ? '重置结果暂未确认，已阻止重复兑换。请在控制台核查，勿重复消耗卡片。' : text
    }
    store.set(key, { ...action, status: claimed ? 'finished' : 'expired' }, action.expires + DAY)
    await send(c, 'editMessageText', {
      chat_id: c.telegram.chat_id,
      message_id: action.message,
      text: `${action.text}\n\n${text}`,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {})
  }
  const handleCallback = (q) => {
    // Serialize all action checks; repeated updates cannot race a card redemption.
    const job = (callbackJob || Promise.resolve()).then(() => handle(q))
    callbackJob = job.catch(() => {})
    return job
  }
  async function poll() {
    const c = config()
    if (!enabled(c)) return
    try {
      if (!(await verify(c))) return
      const cursorKey = `cursor:${hash(c.telegram.bot_token)}`
      const offset = store.get(cursorKey)?.offset || 0
      const updates = await send(c, 'getUpdates', {
        offset,
        timeout: 25,
        limit: 20,
        allowed_updates: ['callback_query'],
      })
      for (const update of Array.isArray(updates) ? updates : []) {
        if (controller.signal.aborted || recipientKey(config()) !== recipientKey(c)) break
        if (update.callback_query) await handleCallback(update.callback_query)
        store.set(cursorKey, { offset: update.update_id + 1 }, now() + 365 * DAY)
      }
      pollError = null
    } catch {
      if (!controller.signal.aborted) {
        verified = null
        pollError = 'Telegram 回调暂不可用（网络或机器人被其他程序占用），稍后重试'
      }
    }
  }
  function start() {
    if (running) return
    running = true
    controller = new AbortController()
    const tick = async () => {
      try {
        await runOnce()
      } catch {
        lastError = '额度检查失败'
      } finally {
        if (running) timer = setTimeout(tick, config().weekly_quota_interval_sec * 1000).unref()
      }
    }
    const pollTick = async () => {
      pollJob = poll()
      try {
        await pollJob
      } finally {
        pollJob = null
        if (running) pollTimer = setTimeout(pollTick, pollError ? 30000 : 3000).unref()
      }
    }
    timer = setTimeout(tick, 1000).unref()
    pollTimer = setTimeout(pollTick, 1500).unref()
  }
  async function stop() {
    running = false
    clearTimeout(timer)
    clearTimeout(pollTimer)
    controller.abort()
    await Promise.allSettled([checkJob, pollJob, callbackJob].filter(Boolean))
    verified = null
  }
  return { start, stop, runOnce, handleCallback, getStatus: status }
}
