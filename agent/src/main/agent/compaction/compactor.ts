import type { ChatMessage, ModelInfo } from '@shared/types'
import { summarizeMessages } from '../../openrouter/client'
import { modelSupportsCaching } from '../../openrouter/caching'

/** Hard cap: compact once history hits this many tokens, no matter how large the model's context window is. */
const MAX_TOKENS_BEFORE_COMPACTION = 200_000

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
    .map((m) => {
      const text = m.blocks
        .filter((b) => b.type === 'text' || b.type === 'thinking')
        .map((b) => ('text' in b ? b.text : ''))
        .join('')
      return `${m.role}: ${text}`
    })
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
