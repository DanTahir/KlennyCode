import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'

const SUMMARY_PREVIEW_CHARS = 400

export function SubagentPanel() {
  const { subagentRuns, activeTabId, hideSubagentRun, clearFinishedSubagentRuns } = useAppStore()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const allRuns = subagentRuns.filter((r) => r.parentTabId === activeTabId)
  const runs = allRuns.filter((r) => !r.hidden)
  const hasFinished = runs.some((r) => r.status !== 'running')
  if (!runs.length) return null

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside className="w-72 border-l border-klenny-border bg-klenny-panel p-3 overflow-y-auto">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-medium">Subagents</div>
        {hasFinished && (
          <button
            className="text-xs text-klenny-muted hover:text-klenny-fg"
            title="Hide finished subagents"
            onClick={() => activeTabId && clearFinishedSubagentRuns(activeTabId)}
          >
            Clear finished
          </button>
        )}
      </div>
      <div className="space-y-2">
        {runs.map((r) => (
          <div key={r.id} className="border border-klenny-border rounded p-2 text-xs relative">
            {r.status !== 'running' && (
              <button
                className="absolute top-1 right-1 text-klenny-muted hover:text-klenny-fg leading-none"
                title="Hide"
                onClick={() => hideSubagentRun(r.id)}
              >
                ×
              </button>
            )}
            <div className="font-mono text-klenny-accent pr-4">{r.agentType}</div>
            <div className="text-klenny-muted">{r.description}</div>
            <div className="mt-1">
              {r.status === 'running' ? (
                <span className="text-klenny-muted italic">{r.activity ?? 'Running...'}</span>
              ) : (
                r.status
              )}
            </div>
            {r.summary && (
              <>
                <pre className="mt-2 whitespace-pre-wrap text-klenny-muted">
                  {expanded.has(r.id) ? r.summary : r.summary.slice(0, SUMMARY_PREVIEW_CHARS)}
                </pre>
                {r.summary.length > SUMMARY_PREVIEW_CHARS && (
                  <button
                    className="mt-1 text-klenny-accent hover:underline"
                    onClick={() => toggleExpanded(r.id)}
                  >
                    {expanded.has(r.id) ? 'Show less' : 'Show more'}
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}
