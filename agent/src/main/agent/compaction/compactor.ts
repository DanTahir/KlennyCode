import type { ChatMessage, DocumentBlock, ModelInfo, ToolCallBlock } from '@shared/types'
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
  // When a prior summary exists, frame it as an "anchored summary" ahead of the newer transcript
  // — see `summarizeMessages`'s `isUpdate` handling, which is told to revise this same block in
  // place (keep still-true entries, drop stale ones, merge in new facts) rather than starting the
  // template over from scratch on every repeat compaction pass.
  const fullTranscript = priorSummary
    ? `Anchored summary from earlier compaction:\n${priorSummary}\n\nNewer messages to fold in:\n${transcript}`
    : transcript

  // Route the summarization call to the cheap utility model rather than the main chat
  // model — summarizing already-written history is mechanical and doesn't need the main
  // model's judgment. Fall back to the main model if the configured utility model isn't
  // in the fetched catalog (deprecated/renamed upstream) so compaction never hard-fails.
  const utilityModelInfo = models.find((m) => m.id === utilityModel) ?? model
  const summaryModelId = utilityModelInfo.id
  const supportsExplicitCaching =
    Boolean(promptCachingEnabled) && utilityModelInfo.supportsExplicitCaching && modelSupportsCaching(utilityModelInfo)
  const summaryText = await summarizeMessages(
    apiKey,
    summaryModelId,
    fullTranscript,
    signal,
    supportsExplicitCaching,
    Boolean(priorSummary)
  )

  return {
    compacted: true,
    summary: summaryText,
    compactedThroughMessageId: old[old.length - 1].id
  }
}

/** The literal marker syntax used below to render a *real*, structurally-verified tool call
 *  (see `toolCallParts`) — the only thing the summarization prompt is told to trust as evidence
 *  a call actually happened. If the model's own text/thinking prose ever contains this exact
 *  pattern (whether from an intentional fabrication the truthful-narration guardrail failed to
 *  stop, or an incidental echo/quote of it), it would be visually indistinguishable from a real
 *  marker once joined onto the same line — silently defeating the "only trust `[called ...]`"
 *  instruction. `sanitizeFabricatedMarkers` neutralizes that pattern in free-text content only,
 *  never in the programmatically-generated `toolCallParts` themselves, so the marker stays a
 *  reliable, unforgeable signal for the summarizer. */
function sanitizeFabricatedMarkers(text: string): string {
  return text.replace(/\[called\s+/gi, '[not-a-real-call: ')
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
    // Sanitize the result payload too — a tool result can easily contain arbitrary text (a
    // fetched web page, file contents, a grep hit, or even the model's own earlier fabricated
    // "[called ...]" prose echoed back to it inside some other tool's output) that happens to
    // contain the literal marker substring. Without this, that content would be just as
    // indistinguishable from a real marker as unsanitized free-text/thinking blocks were before
    // this fix — same threat, just arriving via a different block type.
    const resultText = sanitizeFabricatedMarkers(JSON.stringify(tc.result)).slice(0, MAX_TOOL_RESULT_CHARS_IN_TRANSCRIPT)
    return `tool result (${tc.toolName}): ${resultText}`
  }

  const textParts = m.blocks
    .filter((b) => b.type === 'text' || b.type === 'thinking')
    .map((b) => ('text' in b ? b.text : ''))
    .map(sanitizeFabricatedMarkers)
  // Sanitize document attachment content too — a user-uploaded .md/.txt/.docx's extracted text
  // is just as much arbitrary, attacker-or-accident-controllable text as a fetched web page or
  // tool result is, and could equally contain the literal marker substring.
  const documentParts = (m.blocks.filter((b) => b.type === 'document') as DocumentBlock[]).map(
    (doc) => `[document: ${doc.filename}] ${sanitizeFabricatedMarkers(doc.extractedText).slice(0, MAX_TOOL_RESULT_CHARS_IN_TRANSCRIPT)}`
  )
  // Sanitize the args payload too, same reasoning as the tool-result case above — a string
  // argument (e.g. a file's old_string/new_string, a command, a message body) could itself
  // contain the marker substring. Only the args payload is sanitized, never the surrounding
  // `[called toolName(...)]` wrapper itself, which stays the one reliable, unforgeable signal.
  const toolCallParts = (m.blocks.filter((b) => b.type === 'tool_call') as ToolCallBlock[]).map(
    (tc) => `[called ${tc.toolName}(${sanitizeFabricatedMarkers(JSON.stringify(tc.args))})]`
  )
  const line = [...textParts, ...documentParts, ...toolCallParts].join(' ').trim()
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
