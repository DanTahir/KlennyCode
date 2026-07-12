import { useState } from 'react'
import type { ToolCallBlock } from '@shared/types'

function formatToolError(block: ToolCallBlock): string {
  const data = block.result?.data as Record<string, unknown> | undefined
  if (!data) return block.result?.error ?? ''
  const parts: string[] = []
  if (typeof data.hint === 'string') parts.push(data.hint)
  if (typeof data.nearbyContent === 'string' && data.nearbyContent.trim()) parts.push(data.nearbyContent.trim())
  if (typeof data.stderr === 'string' && data.stderr.trim()) parts.push(data.stderr.trim())
  if (typeof data.stdout === 'string' && data.stdout.trim()) parts.push(data.stdout.trim())
  return parts.join('\n\n') || (block.result?.error ?? '')
}

export function ToolCallCard({ block }: { block: ToolCallBlock }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border border-klenny-border rounded-md text-xs">
      <button className="w-full text-left px-2 py-1 hover:bg-klenny-panel" onClick={() => setOpen(!open)}>
        <span className="font-mono text-klenny-accent">{block.toolName}</span>
        <span className="ml-2 text-klenny-muted">{block.status}</span>
      </button>
      {open && (
        <div className="p-2 border-t border-klenny-border space-y-1">
          <pre className="whitespace-pre-wrap">{JSON.stringify(block.args, null, 2)}</pre>
          {block.result && (
            <>
              <pre className="whitespace-pre-wrap text-klenny-muted">{block.result.summary}</pre>
              {block.status === 'error' && block.result && (
                <pre className="whitespace-pre-wrap text-red-400/90 text-[11px]">
                  {formatToolError(block)}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
