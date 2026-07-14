import { useAppStore } from '../store/useAppStore'

export function SubagentPanel() {
  const { subagentRuns, activeTabId, hideSubagentRun, clearFinishedSubagentRuns } = useAppStore()
  const allRuns = subagentRuns.filter((r) => r.parentTabId === activeTabId)
  const runs = allRuns.filter((r) => !r.hidden)
  const hasFinished = runs.some((r) => r.status !== 'running')
  if (!runs.length) return null

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
            {r.summary && <pre className="mt-2 whitespace-pre-wrap text-klenny-muted">{r.summary.slice(0, 400)}</pre>}
          </div>
        ))}
      </div>
    </aside>
  )
}
