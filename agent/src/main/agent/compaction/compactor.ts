import type { ChatMessage, ModelInfo, ToolCallBlock } from '@shared/types'
import { summarizeMessages } from '../../openrouter/client'
import { modelSupportsCaching } from '../../openrouter/caching'
import { compactToolResult } from '../messages'

/** Hard cap: compact once history hits this many tokens, no matter how large the model's context window is. */
const MAX_TOKENS_BEFORE_COMPACTION = 200_000

/** Per-tool-result cap when folding results into the summarization transcript — bounds the
 *  summarization call's own size while still giving the summarizer the actual data (fetched
 *  page text, file contents, search hits) instead of just the assistant's chat text around it. */
const MAX_TOOL_RESULT_CHARS_IN_TRANSCRIPT = 4_000

/** How many of the most recent messages are always kept verbatim (never folded into the summary). */
const KEEP_RECENT = 12

export async function maybeCompact(opts: {
  messages: ChatMessage[]
  model: ModelInfo
  apiKey: string
  signal?: AbortSignal
  promptCachingEnabled?: boolean
  /** id of the cheap/fast model to use for the summarization call itself (settings.utilityModel) */
  utilityModel: string
  /** full fetched model catalog, used to resolve utilityModel's ModelInfo (for its own caching support) */
  models: ModelInfo[]
  /** existing rolling summary + cutoff from the tab, if compaction has already run at least once */
  priorSummary?: string
  priorCompactedThroughMessageId?: string
}): Promise<{ compacted: boolean; summary?: string; compactedThroughMessageId?: string }> {
  const {
    messages,
    model,
    apiKey,
    signal,
    promptCachingEnabled,
    utilityModel,
    models,
    priorSummary,
    priorCompactedThroughMessageId
  } = opts

  // Only the messages after whatever's already been folded into the summary are candidates for
  // (re-)compaction — `messages` itself is never mutated/trimmed, so we always work off the full,
  // authentic history and just figure out how much of its *tail* still needs summarizing.
  const tail = priorCompactedThroughMessageId
    ? messages.slice(messages.findIndex((m) => m.id === priorCompactedThroughMessageId) + 1)
    : messages

  const tokenEstimate = estimateContextTokens(tail, priorSummary)
  const threshold = Math.min(model.contextLength * 0.75, MAX_TOKENS_BEFORE_COMPACTION)
  if (tokenEstimate < threshold) return { compacted: false }

  if (tail.length <= KEEP_RECENT + 2) return { compacted: false }

  const old = tail.slice(0, -KEEP_RECENT)
  if (old.length === 0) return { compacted: false }

  const transcript = old
    .map((m) => transcriptLineForMessage(m))
    .filter((line): line is string => Boolean(line))
    .join('\n')
  const fullTranscript = priorSummary
    ? `Summary of earlier conversation:\n${priorSummary}\n\nNewer messages to fold into the summary:\n${transcript}`
    : transcript

  // Route the summarization call to the cheap utility model rather than the main chat
  // model — summarizing already-written history is mechanical and doesn't need the main
  // model's judgment. Fall back to the main model if the configured utility model isn't
  // in the fetched catalog (deprecated/renamed upstream) so compaction never hard-fails.
  const utilityModelInfo = models.find((m) => m.id === utilityModel) ?? model
  const summaryModelId = utilityModelInfo.id
  const supportsExplicitCaching =
    Boolean(promptCachingEnabled) && utilityModelInfo.supportsExplicitCaching && modelSupportsCaching(utilityModelInfo)
  const summaryText = await summarizeMessages(apiKey, summaryModelId, fullTranscript, signal, supportsExplicitCaching)

  return {
    compacted: true,
    summary: summaryText,
    compactedThroughMessageId: old[old.length - 1].id
  }
}

/** Renders one message into a transcript line for the summarization prompt. Unlike a plain
 *  text/thinking dump, this also folds in tool calls and their results (fetched page text,
 *  file contents, search/grep hits) — otherwise that data vanishes the moment it scrolls past
 *  the kept-recent window, and the agent ends up re-fetching/re-reading things it already
 *  gathered once compaction has run. */
function transcriptLineForMessage(m: ChatMessage): string | null {
  if (m.role === 'tool') {
    const tc = m.blocks.find((b) => b.type === 'tool_call') as ToolCallBlock | undefined
    if (!tc?.result) return null
    const resultText = JSON.stringify(tc.result).slice(0, MAX_TOOL_RESULT_CHARS_IN_TRANSCRIPT)
    return `tool result (${tc.toolName}): ${resultText}`
  }

  const textParts = m.blocks
    .filter((b) => b.type === 'text' || b.type === 'thinking')
    .map((b) => ('text' in b ? b.text : ''))
  const toolCallParts = (m.blocks.filter((b) => b.type === 'tool_call') as ToolCallBlock[]).map(
    (tc) => `[called ${tc.toolName}(${JSON.stringify(tc.args)})]`
  )
  const line = [...textParts, ...toolCallParts].join(' ').trim()
  return line ? `${m.role}: ${line}` : null
}

/** Estimates how many tokens `tail` (plus `priorSummary`, if any) would cost as context on the
 *  next request. Prefers the real `usage.promptTokens` reported by OpenRouter on the most
 *  recent message that has it — that figure reflects actual tokenization (including whatever
 *  cached/uncached split applies) for everything the model was sent up through that turn — and
 *  only falls back to a char-count heuristic for the handful of messages appended since, or for
 *  the whole tail if no real usage is available yet (e.g. first turn, or a summarize-only path). */
function estimateContextTokens(tail: ChatMessage[], priorSummary?: string): number {
  let lastUsageIdx = -1
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].usage) {
      lastUsageIdx = i
      break
    }
  }

  if (lastUsageIdx === -1) {
    const summaryTokens = priorSummary ? Math.ceil(priorSummary.length / 4) : 0
    return summaryTokens + estimateTokensHeuristic(tail)
  }

  // usage.promptTokens on this message is exactly the size (in tokens) of everything sent to
  // the model *before* it (already including any prior summary, since that was part of the
  // request). Its own completion tokens then get appended to history as this assistant message's
  // text, so they become part of the *next* request's prompt — add them in. Anything appended
  // after this message hasn't been through the API yet, so fall back to the heuristic for just
  // that slice.
  const base = tail[lastUsageIdx].usage!.promptTokens + tail[lastUsageIdx].usage!.completionTokens
  const remainder = tail.slice(lastUsageIdx + 1)
  return base + estimateTokensHeuristic(remainder)
}

function estimateTokensHeuristic(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    for (const b of m.blocks) {
      if ('text' in b && typeof b.text === 'string') chars += b.text.length
      if (b.type === 'tool_call') {
        chars += JSON.stringify(b.args).length
        if (b.result) chars += compactToolResult(b.result).length
      }
    }
  }
  return Math.ceil(chars / 4)
}
