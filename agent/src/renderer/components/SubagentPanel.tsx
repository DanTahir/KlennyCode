import { useAppStore } from '../store/useAppStore'

export function SubagentPanel() {
  const { subagentRuns, activeTabId } = useAppStore()
  const runs = subagentRuns.filter((r) => r.parentTabId === activeTabId)
  if (!runs.length) return null

  return (
    <aside className="w-72 border-l border-klenny-border bg-klenny-panel p-3 overflow-y-auto">
      <div className="text-sm font-medium mb-2">Subagents</div>
      <div className="space-y-2">
        {runs.map((r) => (
          <div key={r.id} className="border border-klenny-border rounded p-2 text-xs">
            <div className="font-mono text-klenny-accent">{r.agentType}</div>
            <div className="text-klenny-muted">{r.description}</div>
            <div className="mt-1">{r.status}</div>
            {r.summary && <pre className="mt-2 whitespace-pre-wrap text-klenny-muted">{r.summary.slice(0, 400)}</pre>}
          </div>
        ))}
      </div>
    </aside>
  )
}
