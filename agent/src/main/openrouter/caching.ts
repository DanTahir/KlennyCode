import type { ModelInfo } from '@shared/types'
import type { ChatMessage, ContentPart } from './client'

/**
 * Alibaba-hosted models that support explicit `cache_control` breakpoints, per OpenRouter's
 * prompt-caching docs. This is a specific allowlist, NOT every `qwen/`-prefixed model — most
 * Qwen models on OpenRouter are hosted by other providers (Fireworks, DeepInfra, Together, ...)
 * that don't understand `cache_control` at all, and even Alibaba's own "snapshot" endpoints
 * (e.g. qwen3.5-plus-02-15, qwen3.5-flash-02-23) are explicitly excluded. Sending the marker to
 * an unsupported endpoint doesn't get you caching — it just risks odd routing/rejection — so we
 * only mark models actually confirmed to support it.
 */
const ALIBABA_EXPLICIT_CACHE_MODEL_IDS = new Set([
  'deepseek/deepseek-v3.2',
  'qwen/qwen3-max',
  'qwen/qwen-plus',
  'qwen/qwen3.6-plus',
  'qwen/qwen3-coder-plus',
  'qwen/qwen3-coder-flash'
])

/**
 * Model families that require us to inject `cache_control` markers ourselves to get
 * prompt caching. Everyone else with cache pricing (OpenAI, Grok, Moonshot, Groq,
 * Gemini 2.5+, native DeepSeek) caches implicitly/automatically server-side.
 */
export function isExplicitCacheFamily(modelId: string): boolean {
  return modelId.startsWith('anthropic/') || ALIBABA_EXPLICIT_CACHE_MODEL_IDS.has(modelId)
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
 * multi-turn caching pattern). Cache-marking is skipped entirely (no-op) when `enabled` is false.
 *
 * `includeLastMessageBreakpoint` should be false on the very first request of a
 * conversation/subagent run, since there's nothing yet to read back from a cache write.
 *
 * `trailingNote`, if given, is appended as a brand-new, uncached content part *after* everything
 * else in the last message (after any cache_control marker it just received) — see the doc
 * comment above `appendTrailingNotePart` for why it must live there and nowhere earlier. Applies
 * regardless of `enabled`: implicit-cache providers (OpenAI, Gemini, ...) benefit from the same
 * "keep dynamic content at the very tail" placement even without explicit cache_control.
 */
export function applyCacheControl(
  messages: ChatMessage[],
  enabled: boolean,
  includeLastMessageBreakpoint: boolean,
  trailingNote?: string
): ChatMessage[] {
  if (messages.length === 0) return messages
  if (!enabled && !trailingNote) return messages

  const out = messages.map((m) => ({ ...m }))

  if (enabled) {
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
  }

  if (trailingNote) {
    const lastIdx = out.length - 1
    out[lastIdx] = appendTrailingNotePart(out[lastIdx], trailingNote)
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

/**
 * Appends `note` as a brand-new, un-cache-controlled content part at the very end of `message`
 * (after any cache_control marker already applied above). This must be the LAST thing in the
 * entire request, structurally after both cache breakpoints — not folded into the system prompt,
 * and not merged into the existing last-message content — because a `cache_control` breakpoint
 * caches everything only up to and including the block it's on; content appended *after* that
 * block rides along uncached without touching the cached hash at all. That's exactly what a
 * live, per-request-changing value (e.g. current date/time) needs: whichever message is "last"
 * this turn keeps an identical, byte-for-byte-stable cached prefix (its real content, marked),
 * and once history grows and this message is no longer last, it's replayed with that exact same
 * stable content — the note was never part of it. Folding a changing value into the system
 * prompt, or merging it into the last message's own content instead of appending after the
 * marker, would instead poison every subsequent breakpoint's hash chain (the actual bug this
 * fixes — see the "current date/time" regression tests in caching.test.ts).
 */
function appendTrailingNotePart(message: ChatMessage, note: string): ChatMessage {
  const parts = toContentParts(message.content)
  return { ...message, content: [...parts, { type: 'text', text: note }] }
}

function toContentParts(content: ChatMessage['content']): ContentPart[] {
  if (typeof content === 'string') {
    if (!content) return []
    return [{ type: 'text', text: content }]
  }
  return content
}
