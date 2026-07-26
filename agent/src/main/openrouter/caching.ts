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
 * the previous request's breakpoint landed (`priorBreakpointIdx`), and one on the current
 * "advancing" breakpoint position — which is deliberately the SECOND-TO-LAST message, not the
 * true last one. Cache-marking is skipped entirely (no-op) when `enabled` is false.
 *
 * Why second-to-last, and not the last message: `trailingNote` (a live, per-request value like
 * the current date/time) is appended to the true last message on every request. If that same
 * message were also the one marked with `cache_control`, its shape would differ between the turn
 * it's written (an extra, ever-changing trailing part alongside the marked content) and every
 * later turn it gets replayed as plain conversation history (just the content, no note, since
 * only the *current* last message ever carries one). That shape mismatch was confirmed
 * empirically to silently break cache matching for the entire conversation — `cachedTokens`
 * stayed flat at system-prompt size turn after turn, even though the marked content itself
 * (ignoring the note) was byte-identical each time. Reserving the true last slot exclusively for
 * the note, and always marking the message just before it instead, means the marked message's
 * shape never changes, ever — which is what actually lets a breakpoint be found and reused
 * (whether via real cross-request lookback or the explicit re-marking below). This matches how
 * caching worked before a "current date/time" note existed at all: there was nothing to append,
 * so the last message's shape was inherently stable turn to turn.
 *
 * Why also re-mark the previous position (`priorBreakpointIdx`): even with the note-vs-breakpoint
 * split above, empirical `[cache]` log evidence (see client.ts) showed a newly-marked breakpoint
 * is not reliably picked up via implicit cross-request lookback through OpenRouter on its own —
 * explicitly re-marking the exact position written last time turns that into a direct breakpoint
 * hit. This is kept as extra insurance on top of the note/breakpoint split; see project notes for
 * whether it's still necessary once the split above is verified to hold on its own.
 *
 * `includeLastMessageBreakpoint` should be false on the very first request of a
 * conversation/subagent run, since there's nothing yet to read back from a cache write.
 *
 * `trailingNote`, if given, is appended as a brand-new, uncached content part on the true last
 * message — the one message this function never cache-marks — so it can change every request
 * without ever touching a cached breakpoint's content, this turn or any future one. Applies
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
  const lastIdx = out.length - 1

  if (enabled) {
    const systemIdx = out.findIndex((m) => m.role === 'system')
    const markedIdxs = new Set<number>(systemIdx >= 0 ? [systemIdx] : [])
    if (systemIdx >= 0) {
      out[systemIdx] = withCacheControlOnLastPart(out[systemIdx])
    }

    // The "advancing" breakpoint normally sits on the true last message, EXCEPT when a
    // trailingNote is being sent this call — then it sits one message earlier, leaving the
    // note-bearing message reserved and never cache-marked. See the doc comment above for why
    // that split matters: a message that's marked with cache_control on one turn and then
    // replayed with a different shape (note present vs. absent) on the next breaks caching for
    // the whole conversation, so the note and the mark must never land on the same message.
    // `reservedIdx` is that off-limits note slot (only exists when trailingNote is set) — used
    // below purely to keep `priorBreakpointIdx` from ever re-marking it by coincidence.
    const breakpointIdx = trailingNote ? lastIdx - 1 : lastIdx
    const reservedIdx = trailingNote ? lastIdx : undefined

    // Re-mark wherever the previous request left its breakpoint, so this request has a direct
    // breakpoint hit there instead of relying on cross-request lookback.
    if (
      priorBreakpointIdx != null &&
      priorBreakpointIdx >= 0 &&
      priorBreakpointIdx > systemIdx &&
      priorBreakpointIdx !== reservedIdx &&
      !markedIdxs.has(priorBreakpointIdx)
    ) {
      out[priorBreakpointIdx] = withCacheControlOnLastPart(out[priorBreakpointIdx])
      markedIdxs.add(priorBreakpointIdx)
    }

    if (includeLastMessageBreakpoint && breakpointIdx > systemIdx && !markedIdxs.has(breakpointIdx)) {
      out[breakpointIdx] = withCacheControlOnLastPart(out[breakpointIdx])
    }
  }

  if (trailingNote) {
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
 * Appends `note` as a brand-new, uncached content part at the very end of `message` — always the
 * true last message in the request, which `applyCacheControl` deliberately never cache-marks
 * when a trailingNote is present (see its doc comment). Because this message is never marked and
 * never becomes part of a cached prefix, its content is free to change on every single request
 * without ever invalidating a breakpoint, this turn or any future one. Folding a changing value
 * into the system prompt, an early message, or the same message that carries a cache_control
 * marker would instead either poison every subsequent breakpoint's hash chain or make a marked
 * message's shape unstable across turns — both confirmed real regressions (see the "current
 * date/time" tests and comments in caching.test.ts).
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
