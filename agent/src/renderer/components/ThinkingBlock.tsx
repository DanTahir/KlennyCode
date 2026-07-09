import { useState } from 'react'

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-2 border border-klenny-border rounded-md">
      <button
        className="w-full text-left px-2 py-1 text-xs text-klenny-muted hover:bg-klenny-panel"
        onClick={() => setOpen(!open)}
      >
        {open ? '▼' : '▶'} Thinking
      </button>
      {open && <pre className="p-2 text-xs whitespace-pre-wrap text-klenny-muted">{text}</pre>}
    </div>
  )
}
