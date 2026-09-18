import { useState } from 'react'
import type { ToolCallBlock } from '@shared/types'
import { formatArgSize } from '@shared/toolWriting'

/** Human-readable status text. 'writing' and 'queued' are deliberately distinct from 'running':
 *  the first means the model is still producing this call's arguments (nothing has been asked of
 *  the system yet), the second means it's recorded but hasn't started — typically sitting in the
 *  approval queue — and only 'running' means the tool is actually doing work. */
const STATUS_LABEL: Record<ToolCallBlock['status'], string> = {
  writing: 'writing…',
  queued: 'queued',
  running: 'running',
  awaiting_approval: 'awaiting approval',
  success: 'success',
  error: 'error',
  rejected: 'rejected'
}

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
  const isWriting = block.status === 'writing'
  // A 'writing' card is a live placeholder: its arguments are still streaming in, so there is
  // nothing meaningful to expand yet (args is `{}` by construction).
  const expandable = !isWriting
  return (
    <div
      className={`border rounded-md text-xs ${isWriting ? 'border-klenny-accent/40' : 'border-klenny-border'}`}
    >
      <button
        className={`w-full text-left px-2 py-1 ${expandable ? 'hover:bg-klenny-panel' : 'cursor-default'}`}
        onClick={() => {
          if (expandable) setOpen(!open)
        }}
        aria-disabled={!expandable}
      >
        <span className="font-mono text-klenny-accent">{block.toolName}</span>
        <span className="ml-2 inline-flex items-center gap-1.5 align-middle text-klenny-muted">
          {(isWriting || block.status === 'running') && (
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isWriting ? 'bg-klenny-accent animate-pulse' : 'bg-klenny-muted'
              }`}
            />
          )}
          {STATUS_LABEL[block.status] ?? block.status}
        </span>
        {isWriting && <span className="ml-2 text-klenny-muted">{formatArgSize(block.writingChars ?? 0)}</span>}
        {isWriting && block.writingLabel && (
          <span className="ml-2 text-klenny-muted italic">{block.writingLabel}</span>
        )}
        {block.status === 'running' && block.progressMessage && (
          <span className="ml-2 text-klenny-muted italic">{block.progressMessage}</span>
        )}
      </button>
      {open && expandable && (
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
