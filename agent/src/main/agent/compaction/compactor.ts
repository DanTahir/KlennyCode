import type { ChatMessage, ModelInfo } from '@shared/types'
import { summarizeMessages } from '../../openrouter/client'
import { modelSupportsCaching } from '../../openrouter/caching'

export async function maybeCompact(opts: {
  messages: ChatMessage[]
  model: ModelInfo
  apiKey: string
  signal?: AbortSignal
  promptCachingEnabled?: boolean
}): Promise<{ messages: ChatMessage[]; compacted: boolean; summaryMessageId?: string }> {
  const { messages, model, apiKey, signal, promptCachingEnabled } = opts
  const tokenEstimate = estimateTokens(messages)
  const threshold = model.contextLength * 0.75
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

  const supportsExplicitCaching = Boolean(promptCachingEnabled) && model.supportsExplicitCaching && modelSupportsCaching(model)
  const summaryText = await summarizeMessages(apiKey, model.id, transcript, signal, supportsExplicitCaching)
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
