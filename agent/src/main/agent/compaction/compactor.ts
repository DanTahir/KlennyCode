import type { ChatMessage, ModelInfo, ToolCallBlock } from '@shared/types'
import { summarizeMessages } from '../../openrouter/client'
import { modelSupportsCaching } from '../../openrouter/caching'

/** Hard cap: compact once history hits this many tokens, no matter how large the model's context window is. */
const MAX_TOKENS_BEFORE_COMPACTION = 200_000

/** Per-tool-result cap when folding results into the summarization transcript — bounds the
 *  summarization call's own size while still giving the summarizer the actual data (fetched
 *  page text, file contents, search hits) instead of just the assistant's chat text around it. */
const MAX_TOOL_RESULT_CHARS_IN_TRANSCRIPT = 4_000

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
}): Promise<{ messages: ChatMessage[]; compacted: boolean; summaryMessageId?: string }> {
  const { messages, model, apiKey, signal, promptCachingEnabled, utilityModel, models } = opts
  const tokenEstimate = estimateTokens(messages)
  const threshold = Math.min(model.contextLength * 0.75, MAX_TOKENS_BEFORE_COMPACTION)
  if (tokenEstimate < threshold) return { messages, compacted: false }

  const keepRecent = 12
  if (messages.length <= keepRecent + 2) return { messages, compacted: false }

  const old = messages.slice(0, -keepRecent)
  const recent = messages.slice(-keepRecent)
  const transcript = old
    .map((m) => transcriptLineForMessage(m))
    .filter((line): line is string => Boolean(line))
    .join('\n')

  // Route the summarization call to the cheap utility model rather than the main chat
  // model — summarizing already-written history is mechanical and doesn't need the main
  // model's judgment. Fall back to the main model if the configured utility model isn't
  // in the fetched catalog (deprecated/renamed upstream) so compaction never hard-fails.
  const utilityModelInfo = models.find((m) => m.id === utilityModel) ?? model
  const summaryModelId = utilityModelInfo.id
  const supportsExplicitCaching =
    Boolean(promptCachingEnabled) && utilityModelInfo.supportsExplicitCaching && modelSupportsCaching(utilityModelInfo)
  const summaryText = await summarizeMessages(apiKey, summaryModelId, transcript, signal, supportsExplicitCaching)
  const summaryMessage: ChatMessage = {
    id: `compact_${Date.now()}`,
    role: 'system',
    blocks: [{ type: 'text', text: `Earlier conversation summary:\n\n${summaryText}` }],
    createdAt: Date.now(),
    isCompactionSummary: true
  }

  return {
    messages: [summaryMessage, ...recent],
    compacted: true,
    summaryMessageId: summaryMessage.id
  }
}

/** Renders one message into a transcript line for the summarization prompt. Unlike a plain
 *  text/thinking dump, this also folds in tool calls and their results (fetched page text,
 *  file contents, search/grep hits) — otherwise that data vanishes the moment it scrolls past
 *  the `keepRecent` window, and the agent ends up re-fetching/re-reading things it already
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

function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    for (const b of m.blocks) {
      if ('text' in b && typeof b.text === 'string') chars += b.text.length
      if (b.type === 'tool_call') chars += JSON.stringify(b.args).length
    }
  }
  return Math.ceil(chars / 4)
}
