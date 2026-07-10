import type { ModelInfo } from '@shared/types'
import type { ChatMessage, ContentPart } from './client'

/**
 * Model families that require us to inject `cache_control` markers ourselves to get
 * prompt caching. Everyone else with cache pricing (OpenAI, Grok, Moonshot, Groq,
 * Gemini 2.5+, native DeepSeek) caches implicitly/automatically server-side.
 */
export function isExplicitCacheFamily(modelId: string): boolean {
  return modelId.startsWith('anthropic/') || modelId.startsWith('qwen/') || modelId === 'deepseek/deepseek-v3.2'
}

/** Whether this model has any caching support at all (read pricing present). */
export function modelSupportsCaching(model: ModelInfo): boolean {
  return model.cacheReadPrice != null
}

export interface CacheUsageInput {
  promptTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  completionTokens: number
  costUsd: number
}

/**
 * Computes what this turn would have cost with no caching at all, and the resulting
 * savings (can be negative on a pure cache-write turn, where the write premium hasn't
 * been recouped yet).
 */
export function computeCacheSavings(
  model: ModelInfo,
  usage: CacheUsageInput
): { costWithoutCacheUsd: number; cacheSavingsUsd: number } {
  const uncachedPromptTokens = Math.max(usage.promptTokens - usage.cachedTokens - usage.cacheWriteTokens, 0)
  const noCacheCost =
    uncachedPromptTokens * model.promptPrice +
    usage.cachedTokens * model.promptPrice + // if it hadn't been cached, it'd cost full price
    usage.cacheWriteTokens * model.promptPrice +
    usage.completionTokens * model.completionPrice
  const costWithoutCacheUsd = Math.max(noCacheCost, 0)
  return { costWithoutCacheUsd, cacheSavingsUsd: costWithoutCacheUsd - usage.costUsd }
}

/**
 * Shapes an outgoing messages array to add Anthropic/Qwen-style explicit `cache_control`
 * breakpoints: one on the system message (stable, reused every turn) and one on the last
 * content part of the last message (advances forward each turn, per Anthropic's recommended
 * multi-turn caching pattern). No-op (returns the same array) when `enabled` is false.
 *
 * `includeLastMessageBreakpoint` should be false on the very first request of a
 * conversation/subagent run, since there's nothing yet to read back from a cache write.
 */
export function applyCacheControl(
  messages: ChatMessage[],
  enabled: boolean,
  includeLastMessageBreakpoint: boolean
): ChatMessage[] {
  if (!enabled || messages.length === 0) return messages

  const out = messages.map((m) => ({ ...m }))

  const systemIdx = out.findIndex((m) => m.role === 'system')
  if (systemIdx >= 0) {
    out[systemIdx] = withCacheControlOnLastPart(out[systemIdx])
  }

  if (includeLastMessageBreakpoint) {
    const lastIdx = out.length - 1
    // Avoid double-marking if the system message is also the last message (single-message request)
    if (lastIdx !== systemIdx) {
      out[lastIdx] = withCacheControlOnLastPart(out[lastIdx])
    }
  }

  return out
}

function withCacheControlOnLastPart(message: ChatMessage): ChatMessage {
  const parts = toContentParts(message.content)
  if (parts.length === 0) return message
  const lastIdx = parts.length - 1
  const updatedParts = parts.map((p, i) => (i === lastIdx ? { ...p, cache_control: { type: 'ephemeral' as const } } : p))
  return { ...message, content: updatedParts }
}

function toContentParts(content: ChatMessage['content']): ContentPart[] {
  if (typeof content === 'string') {
    if (!content) return []
    return [{ type: 'text', text: content }]
  }
  return content
}
