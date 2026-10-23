/**
 * Read-only outbound reference for the settings panel: what the selected
 * preset sends and where each value comes from. No secrets, no request data.
 */
import { resolveSlotPersonaPreset, normalizeSlotPersonaPreset } from '../vm/slot-engine.mjs'
import {
  OFFICIAL_303_PRESET,
  OFFICIAL_PROFILES,
  officialModelLine,
  profileForPreset,
} from '../identity/official-profiles.mjs'
import { officialClaudeCliUa } from '../identity/vm-identity.mjs'
import { cacheTtlFromRouting } from '../protocol/cache-ttl.mjs'
import { thinkingDisplayMode } from '../protocol/thinking.mjs'
import { credentialModeFromOauth, isAnySetupTokenMode, isApiKeyMode } from '../oauth/credential-mode.mjs'
import { apiKeyBetaHeader, defaultOfficialBetaHeader, setupTokenBetaHeader } from '../protocol/claude-code-betas.mjs'

const SAMPLE_MODEL = 'claude-opus-5-5'

const LEAN_RULES = Object.freeze({
  system: ['billing（不打点）', 'identity（打点）', '2.1.303 主提示词（打点）'],
  messages: [
    '非官方调用方的 system → 第一条 user 最前面的 <system-reminder>',
    '官方调用方的 system 不出站（含旧版 / 新版主提示词）',
    '最后一条 user 的最后一个非 thinking 块打点',
    'Environment 作为尾部 role=system（不打点）；已有 role=system 只替换 # Environment 段',
    '不支持 mid-conversation system 的模型：Environment 并入主提示词块',
  ],
  markers: 3,
  auto_fill: [],
})

function shapeTable() {
  return [
    {
      shape: 'lean',
      label: '2.1.303 样本形状',
      models: 'Opus 4.8 / 5 / 5.5、Fable、Mythos 及其余模型',
      rules: LEAN_RULES,
    },
    {
      shape: 'full',
      label: '现有 cli-hop 结构',
      models: 'Sonnet、Haiku、Claude 3、Opus 4.0–4.7',
      rules: { note: '与 official_full 相同的 system / 断点，只把版本号换成 2.1.303' },
    },
  ]
}

function betaSample(mode) {
  if (isApiKeyMode(mode)) return apiKeyBetaHeader(defaultOfficialBetaHeader(SAMPLE_MODEL))
  if (isAnySetupTokenMode(mode)) return setupTokenBetaHeader(SAMPLE_MODEL)
  return defaultOfficialBetaHeader(SAMPLE_MODEL)
}

function slotTimezone(vm) {
  return String(vm?.timezone || vm?.fingerprint?.timezone || '').trim() || null
}

/**
 * @param routing routing.json
 * @param vm optional slot; null means the global protocol setting
 */
export function buildOutboundProfile({ routing = {}, vm = null } = {}) {
  const compat = routing?.compatibility || {}
  const override = vm ? normalizeSlotPersonaPreset(vm.persona_preset, { inherit: true }) : ''
  const preset = resolveSlotPersonaPreset(vm || {}, routing)
  const profile = profileForPreset(preset)
  const lean = preset === OFFICIAL_303_PRESET
  const mode = vm ? credentialModeFromOauth(vm.claude || {}) : 'oauth'
  const passthrough = compat.official_cc_passthrough === true
  return {
    scope: vm ? 'vm' : 'global',
    vm_id: vm?.id || null,
    preset: { value: preset, source: override ? 'vm' : 'panel' },
    profile: {
      version: profile.cliVersion,
      descriptive: profile.descriptive === true,
      source: 'profile',
    },
    user_agent: { value: officialClaudeCliUa(profile.cliVersion), source: 'profile' },
    stainless_package_version: { value: profile.stainlessPackageVersion, source: 'profile' },
    billing: {
      fields: ['cc_version', 'cc_entrypoint', 'cch', 'cc_prompt_id'],
      cc_version: `${profile.cliVersion}.<fingerprint>`,
      source: 'profile',
    },
    anthropic_beta: {
      credential_mode: vm ? mode : null,
      sample_model: SAMPLE_MODEL,
      value: betaSample(mode),
      note: '凭据类型的基础集；thinking / effort / role=system 等请求字段另按 gate 追加',
      source: 'credential',
    },
    shapes: lean ? shapeTable() : null,
    model_line_sample: lean ? officialModelLine(SAMPLE_MODEL) : null,
    top_level_order: lean ? [...OFFICIAL_PROFILES['2.1.303'].topLevelOrder] : null,
    cache_ttl: { value: cacheTtlFromRouting(routing), source: 'panel' },
    cch_enabled: { value: compat.cch_enabled !== false, source: 'panel' },
    timezone: { value: vm ? slotTimezone(vm) : null, source: 'slot' },
    thinking_display: { value: thinkingDisplayMode(routing), source: 'panel' },
    official_cc_passthrough: {
      value: passthrough,
      source: 'panel',
      note: 'cli-hop 不读取此开关：system 由档位决定（只影响 HTTP 路径与入站断点校验）',
    },
  }
}
