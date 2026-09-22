export const LOADTEST_TABS = [
  ['reports', '研报'],
  ['probe', '能力'],
  ['forms', '答题'],
] as const

export type LoadtestTabId = (typeof LOADTEST_TABS)[number][0]

export const LT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
]

/** 研报 tab 的预设标的，与 index.html `LT_STOCKS` 一致。 */
export const LT_STOCKS = [
  { ticker: 'TSLA', name: 'Tesla' },
  { ticker: 'AAPL', name: 'Apple' },
  { ticker: 'GOOGL', name: 'Google' },
  { ticker: 'AMZN', name: 'AWS' },
  { ticker: 'SNDK', name: 'Sandisk' },
]

/** 轮次分段说明，与 index.html `LT_TURNS` 一致。 */
export const LT_TURNS = [
  { n: 1, label: '只写研报' },
  { n: 2, label: '研报 + 评级' },
  { n: 3, label: '研报 + 评级 + 情景' },
] as const

/** 探针专属模型列表，与研报 tab 的 `LT_MODELS` 是不同的一份（index.html `PROBE_MODELS`）。 */
export const PROBE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-5', label: 'Opus 4.5' },
]

/** 能力探针的 5 个用例，与 index.html `PROBE_CASES` 一致。 */
export const PROBE_CASES = [
  { id: 'follow', label: '指令复述' },
  { id: 'spatial', label: '空间颜色' },
  { id: 'needle', label: '长文检索' },
  { id: 'numbers', label: '计算' },
  { id: 'extract', label: '字段抽取' },
]

/** 答题探针的 3 种作答形态，与 index.html `PROBE_FORMS` 一致。 */
export const PROBE_FORMS = [
  { id: 'answer', label: '只答' },
  { id: 'reason', label: '分步' },
  { id: 'mixed', label: '先答后补' },
]

export const PROBE_BANK = 24
export const PROBE_SAMPLE_MAX = 12

/** 探针异常码 → 中文标签，与 index.html `PROBE_ANOMALY` 一致。 */
export const PROBE_ANOMALY: Record<string, string> = {
  http: 'HTTP',
  empty: '空正文',
  thinking_only: '只思考',
  truncated: '截断',
  refusal: '拒答',
  deflected: '绕开',
  mismatch: '答错',
  no_reason: '无过程',
}

export function loadtestTabId(tab: string | undefined): LoadtestTabId {
  return LOADTEST_TABS.some((item) => item[0] === tab)
    ? (tab as LoadtestTabId)
    : 'reports'
}
