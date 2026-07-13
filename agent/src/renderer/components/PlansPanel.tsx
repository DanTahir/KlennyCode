import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'

/** Strips Markdown syntax down to plain text for a short preview snippet. */
function excerpt(markdown: string, maxLen = 160): string {
  const plain = markdown
    .replace(/^#{1,6}\s+.*$/gm, '') // drop heading lines (title is shown separately)
    .replace(/```[\s\S]*?```/g, ' ') // drop code blocks
    .replace(/[`*_>#-]/g, '') // drop stray markdown punctuation
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > maxLen ? `${plain.slice(0, maxLen).trim()}…` : plain
}

export function PlansPanel() {
  const { plans, setPlans, activeTabId, openPlanTabs, openPlanTab } = useAppStore()

  useEffect(() => {
    void window.klenny.listPlans().then(setPlans)
  }, [])

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-3">
      <h2 className="text-xl font-semibold">Plans</h2>
      {plans.length === 0 && <p className="text-klenny-muted text-sm">No plans yet. Use Plan mode in chat to create one.</p>}
      {plans.map((p) => {
        const isOpen = openPlanTabs.some((t) => t.slug === p.slug)
        return (
          <button
            key={p.slug}
            className="w-full text-left border border-klenny-border rounded-lg p-4 bg-klenny-panel2 hover:border-klenny-accent/50 transition-colors"
            onClick={() => {
              const existing = openPlanTabs.find((t) => t.slug === p.slug)
              openPlanTab(p.slug, existing?.originTabId ?? activeTabId ?? null)
            }}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-semibold text-klenny-accent truncate">{p.title}</h3>
              <span className="text-xs text-klenny-muted whitespace-nowrap ml-3">
                {isOpen ? 'Open in tab · ' : ''}
                {new Date(p.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-sm text-klenny-muted">{excerpt(p.markdown)}</p>
          </button>
        )
      })}
    </div>
  )
}
