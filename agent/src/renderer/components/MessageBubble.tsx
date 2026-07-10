import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage, ToolCallBlock } from '@shared/types'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolCallCard } from './ToolCallCard'
import { DiffViewer } from './DiffViewer'
import klennyGif from '../assets/klenny.gif'

export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const isEmptyAssistant = !isUser && message.blocks.length === 0

  if (isEmptyAssistant) {
    return (
      <div className="flex justify-start">
        <img src={klennyGif} alt="Klenny is working…" className="h-12 w-12 rounded-md object-cover" />
      </div>
    )
  }

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? 'bg-klenny-accent/20 border border-klenny-accent/30' : 'bg-klenny-panel2 border border-klenny-border'
        }`}
      >
        {message.isCompactionSummary && (
          <div className="text-xs text-klenny-muted mb-2">Compaction summary</div>
        )}
        {message.blocks.map((block, i) => {
          if (block.type === 'text') {
            return (
              <div key={i} className="markdown prose prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
              </div>
            )
          }
          if (block.type === 'thinking') return <ThinkingBlock key={i} text={block.text} />
          if (block.type === 'image') {
            return <img key={i} src={block.dataUrl} alt="uploaded" className="max-h-48 rounded mt-2" />
          }
          if (block.type === 'tool_call') {
            const tc = block as ToolCallBlock
            const diff = (tc.result?.data as { diff?: string })?.diff
            return (
              <div key={i} className="mt-2 space-y-2">
                <ToolCallCard block={tc} />
                {diff && <DiffViewer diff={diff} />}
              </div>
            )
          }
          return null
        })}
        {message.usage && (
          <div className="text-[10px] text-klenny-muted mt-2">
            {message.usage.completionTokens} completion tokens · ${message.usage.costUsd.toFixed(4)}
            {message.usage.cachedTokens > 0 && (
              <span className="text-green-400">
                {' '}
                · {message.usage.cachedTokens} cached (saved ${Math.max(message.usage.cacheSavingsUsd, 0).toFixed(4)})
              </span>
            )}
            {message.usage.cacheWriteTokens > 0 && (
              <span className="text-klenny-muted"> · {message.usage.cacheWriteTokens} cache-write</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
