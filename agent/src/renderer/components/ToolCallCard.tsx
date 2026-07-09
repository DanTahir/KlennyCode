import { useState } from 'react'
import type { ToolCallBlock } from '@shared/types'

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
          {block.result && <pre className="whitespace-pre-wrap text-klenny-muted">{block.result.summary}</pre>}
        </div>
      )}
    </div>
  )
}
