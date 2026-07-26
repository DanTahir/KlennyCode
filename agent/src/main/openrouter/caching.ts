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
 * breakpoints: one on the system message (stable, reused every turn), one *re-marking* wherever
 * the previous request's last-message breakpoint landed (`priorBreakpointIdx`), and one on the
 * new last message (advances forward each turn). Cache-marking is skipped entirely (no-op) when
 * `enabled` is false.
 *
 * Why re-mark the previous position at all: Anthropic's docs describe cache reads as an implicit
 * backward lookback — mark only the new last message each turn, and the API is documented to
 * walk backward and find whatever the previous turn wrote, with no need to re-mark it. In
 * practice, through OpenRouter, that implicit lookback does not find prior non-system
 * breakpoints — only measured behavior: the system breakpoint (marked identically every request)
 * gets read hits, but a "last message" breakpoint that moves forward each turn without ever being
 * re-marked *never* gets picked up on the next request; every turn re-writes the entire
 * conversation-since-system from scratch (see the regression this fixes, and the `[cache]`
 * request/usage log lines in client.ts used to capture that evidence). Explicitly re-marking the
 * exact position written last time turns that into a direct breakpoint hit instead of a hopeful
 * walk-back, at the cost of one more of the 4 available breakpoint slots (we use 3 of 4 here).
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
  trailingNote?: string,
  priorBreakpointIdx?: number
): ChatMessage[] {
  if (messages.length === 0) return messages
  if (!enabled && !trailingNote) return messages

  const out = messages.map((m) => ({ ...m }))

  if (enabled) {
    const systemIdx = out.findIndex((m) => m.role === 'system')
    if (systemIdx >= 0) {
      out[systemIdx] = withCacheControlOnLastPart(out[systemIdx])
    }

    const lastIdx = out.length - 1
    const markedIdxs = new Set<number>(systemIdx >= 0 ? [systemIdx] : [])

    // Re-mark wherever the previous request left its "last message" breakpoint, so this
    // request has a direct breakpoint hit there instead of relying on cross-request lookback.
    if (
      priorBreakpointIdx != null &&
      priorBreakpointIdx >= 0 &&
      priorBreakpointIdx < lastIdx &&
      !markedIdxs.has(priorBreakpointIdx)
    ) {
      out[priorBreakpointIdx] = withCacheControlOnLastPart(out[priorBreakpointIdx])
      markedIdxs.add(priorBreakpointIdx)
    }

    if (includeLastMessageBreakpoint && !markedIdxs.has(lastIdx)) {
      out[lastIdx] = withCacheControlOnLastPart(out[lastIdx])
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
