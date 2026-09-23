import type { ComponentType } from 'react'
import {
  Ai21,
  Aws,
  Baidu,
  ByteDance,
  Claude,
  Cohere,
  DeepSeek,
  Google,
  Grok,
  Meta,
  Microsoft,
  Minimax,
  Mistral,
  Moonshot,
  Nvidia,
  OpenAI,
  Perplexity,
  Qwen,
  Stepfun,
  Tencent,
  Yi,
  Zhipu,
} from '@lobehub/icons'
import {
  inferVendorFromModelName,
  UNKNOWN_VENDOR,
} from '@/lib/model-vendor/vendor-inference'
import { cn } from '@/lib/utils'

type IconProps = { className?: string; size?: number }

const VENDOR_ICONS: Record<string, ComponentType<IconProps>> = {
  anthropic: Claude.Color,
  openai: OpenAI,
  google: Google.Color,
  meta: Meta.Color,
  deepseek: DeepSeek.Color,
  alibaba: Qwen.Color,
  qwen: Qwen.Color,
  mistral: Mistral.Color,
  xai: Grok,
  cohere: Cohere.Color,
  ai21: Ai21.BrandColor,
  moonshotai: Moonshot,
  zhipuai: Zhipu.Color,
  minimax: Minimax.Color,
  perplexity: Perplexity.Color,
  stepfun: Stepfun,
  baidu: Baidu.Color,
  tencent: Tencent.Color,
  bytedance: ByteDance.Color,
  nvidia: Nvidia.Color,
  amazon: Aws.Color,
  microsoft: Microsoft.Color,
  '01-ai': Yi.Color,
}

function Monogram({ seed, className }: { seed: string; className?: string }) {
  const letter = (/[a-z0-9]/i.exec(seed)?.[0] ?? '?').toUpperCase()
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-muted text-[9px] font-semibold text-muted-foreground',
        className
      )}
    >
      {letter}
    </span>
  )
}

/** 模型名旁的厂商徽标。能识别的用品牌图标，其余用首字母。 */
export function ModelVendorIcon({
  modelId,
  className,
}: {
  modelId: string
  className?: string
}) {
  const vendor = inferVendorFromModelName(modelId)
  const Icon = vendor === UNKNOWN_VENDOR ? undefined : VENDOR_ICONS[vendor]
  if (!Icon) {
    return (
      <Monogram
        seed={vendor === UNKNOWN_VENDOR ? modelId : vendor}
        className={className}
      />
    )
  }
  return <Icon className={cn('size-3.5 shrink-0', className)} size={14} />
}
