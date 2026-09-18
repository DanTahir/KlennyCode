import { createHash } from 'node:crypto'
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

// ---------- Cache priming for concurrent fan-out (parallel_write) ----------
//
// parallel_write sends N worker requests at once that share a byte-identical system prompt. A
// provider writes its cache when a request *completes*, so firing all N concurrently means every
// one of them misses and pays the full prefix. "Priming" sends one throwaway request (maxTokens:
// 1) with that same prefix first, so the N workers read a cache instead of each writing one.
//
// Whether that is actually worth doing is arithmetic, not judgement — hence shouldPrimeCache
// below rather than a hand-flipped constant. An extra request is real money, and a priming
// request that doesn't produce cache hits is pure waste, so the gate is deliberately biased
// toward NOT priming: every precondition must pass and the projected saving must clear a margin.

/** Providers ignore a cache breakpoint on a prefix below roughly this size (Anthropic's documented
 *  minimum cacheable prefix is ~1024 tokens for most models), so priming one cannot pay off. */
export const MIN_CACHEABLE_PREFIX_TOKENS = 1024

/** Required projected saving before spending an extra request. Guards against priming on a
 *  knife-edge where our token estimate being slightly wrong would flip the decision to a loss. */
export const PRIMING_MARGIN = 0.15

/** How long we assume a just-written ephemeral cache entry stays readable. Deliberately under the
 *  ~5 minute ephemeral TTL Anthropic documents, so we err toward "assume still cached" (skip
 *  priming) rather than paying a second write premium for a prefix that is in fact still warm. */
export const PREFIX_CACHE_TTL_MS = 4 * 60 * 1000

/** Fraction of the shared prefix at least one worker must report as a cache read before we accept
 *  that priming worked on this model. Well below 1.0 because providers report cached tokens with
 *  their own block granularity, so an exact match is not expected. */
const PRIMING_EFFECTIVE_READ_RATIO = 0.5

/** Rough token count for a prompt prefix. Chars/4 is the standard crude estimate; it only needs to
 *  be good enough to compare against MIN_CACHEABLE_PREFIX_TOKENS and to scale both sides of the
 *  cost comparison identically (where the estimate cancels out entirely). */
export function estimatePrefixTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Stable identity for a shared prefix, used only as a local map key to remember that we already
 *  sent this exact prefix recently. */
export function hashPrefix(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/**
 * Models for which priming demonstrably did nothing, learned at runtime and remembered for the
 * life of the process.
 *
 * Mirrors `reasoningRejectedModels` in client.ts, and for the same hard-won reason: a recovery or
 * optimization path that re-fires every single time despite never working is strictly worse than
 * never having attempted it. One wasted priming request per model per process is an acceptable
 * price for discovering this empirically; one per call forever is not.
 */
const cachePrimingIneffective = new Set<string>()

/** Shared prefixes we've already sent, and when — a prefix still inside PREFIX_CACHE_TTL_MS is
 *  assumed warm, making a priming request a pure loss. */
const prefixSentAt = new Map<string, number>()

export function markCachePrimingIneffective(modelId: string): void {
  cachePrimingIneffective.add(modelId)
}

export function isCachePrimingIneffective(modelId: string): boolean {
  return cachePrimingIneffective.has(modelId)
}

export function notePrefixSent(prefixHash: string, at: number = Date.now()): void {
  prefixSentAt.set(prefixHash, at)
}

export function prefixLastSentAt(prefixHash: string): number | null {
  return prefixSentAt.get(prefixHash) ?? null
}

/** Test-only: clears both pieces of process-lived priming state. */
export function resetCachePrimingState(): void {
  cachePrimingIneffective.clear()
  prefixSentAt.clear()
}

/**
 * Did a primed batch actually read from the cache?
 *
 * Called with each worker's reported `cachedTokens`. If not one worker read a meaningful share of
 * the shared prefix back, the priming request bought nothing on this model/provider and the model
 * should be marked ineffective. An empty array means we have no evidence either way (e.g. the
 * provider reported no usage at all) and is deliberately NOT treated as failure — absence of
 * telemetry is not proof of absence of caching.
 */
export function primingLookedIneffective(cachedTokensPerWorker: number[], prefixTokens: number): boolean {
  if (cachedTokensPerWorker.length === 0) return false
  if (prefixTokens <= 0) return false
  const best = Math.max(...cachedTokensPerWorker)
  return best < prefixTokens * PRIMING_EFFECTIVE_READ_RATIO
}

export interface PrimingDecisionInput {
  model: ModelInfo
  /** estimated size of the prefix shared byte-for-byte by every worker in this batch */
  prefixTokens: number
  /** number of concurrent worker requests that will share that prefix */
  jobCount: number
  /** when this exact prefix was last sent, or null if never (see prefixLastSentAt) */
  prefixLastSentAt: number | null
  now: number
  /** whether priming has already been observed to do nothing for this model */
  ineffective: boolean
}

/** `reason` is always populated — it's logged next to the `[cache]` lines during the one-time
 *  empirical validation, and asserted on in tests so a precondition can't silently stop firing. */
export interface PrimingDecision {
  prime: boolean
  reason: string
  /** projected cost of fanning out cold, in USD, for the shared prefix only */
  unprimedCostUsd: number
  /** projected cost of one write plus N reads of that prefix, in USD */
  primedCostUsd: number
}

/**
 * Pure decision: should we spend one extra request to warm the shared prefix before fanning out?
 *
 * Kept free of clocks, I/O and module state (everything arrives via `input`) so the whole decision
 * table can be unit-tested, which is the point — this replaces a human reading logs and flipping a
 * constant with something a regression test can pin.
 */
export function shouldPrimeCache(input: PrimingDecisionInput): PrimingDecision {
  const { model, prefixTokens, jobCount } = input
  // Cost of the shared prefix only; per-job content is unaffected by priming either way, so it
  // cancels out and is deliberately excluded from both sides.
  const readPrice = model.cacheReadPrice ?? model.promptPrice
  // A null cacheWritePrice means the provider publishes no write premium (implicit-only or free
  // writes) — charge the base prompt price rather than assuming free, so the gate never arms on
  // an optimistic guess about pricing we don't actually have.
  const writePrice = model.cacheWritePrice ?? model.promptPrice
  const unprimedCostUsd = jobCount * prefixTokens * model.promptPrice
  const primedCostUsd = prefixTokens * writePrice + jobCount * prefixTokens * readPrice
  const decided = (prime: boolean, reason: string): PrimingDecision => ({ prime, reason, unprimedCostUsd, primedCostUsd })

  if (!Number.isFinite(jobCount) || jobCount < 2) {
    return decided(false, 'only one job — a priming request would add a request without amortizing over anyone')
  }
  if (!modelSupportsCaching(model)) {
    return decided(false, 'model publishes no cache-read price, so there is no cache to prime')
  }
  if (!model.supportsExplicitCaching) {
    return decided(false, 'model caches implicitly; we control no breakpoint here, so priming behaviour is unverifiable')
  }
  if (!Number.isFinite(prefixTokens) || prefixTokens < MIN_CACHEABLE_PREFIX_TOKENS) {
    return decided(false, `shared prefix is ~${prefixTokens} tokens, below the ${MIN_CACHEABLE_PREFIX_TOKENS}-token minimum cacheable prefix`)
  }
  if (input.ineffective) {
    return decided(false, 'priming previously produced no cache reads on this model')
  }
  if (input.prefixLastSentAt != null && input.now - input.prefixLastSentAt < PREFIX_CACHE_TTL_MS) {
    return decided(false, 'this exact prefix was sent recently and is assumed still cached, so priming would pay a second write premium for nothing')
  }
  if (primedCostUsd > unprimedCostUsd * (1 - PRIMING_MARGIN)) {
    return decided(
      false,
      `projected saving too small: priming costs ${primedCostUsd.toExponential(2)} vs ${unprimedCostUsd.toExponential(2)} cold, under the ${Math.round(PRIMING_MARGIN * 100)}% margin`
    )
  }
  return decided(
    true,
    `priming projected to cost ${primedCostUsd.toExponential(2)} vs ${unprimedCostUsd.toExponential(2)} cold across ${jobCount} workers`
  )
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
