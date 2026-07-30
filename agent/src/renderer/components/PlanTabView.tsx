import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppStore } from '../store/useAppStore'
import type { PlanArtifact } from '@shared/types'

/** Full-page view of a single plan, rendered as its own tab in the main tab bar. */
export function PlanTabView({ slug }: { slug: string }) {
  const { plans, upsertPlan, openPlanTabs, tabs, activeTabId, setActiveTab, closePlanTab } = useAppStore()
  const [loading, setLoading] = useState(false)
  const [approving, setApproving] = useState(false)

  const plan = plans.find((p) => p.slug === slug)
  const openTab = openPlanTabs.find((t) => t.slug === slug)

  useEffect(() => {
    if (plan || loading) return
    setLoading(true)
    void window.klenny
      .readPlan(slug)
      .then((p: PlanArtifact | null) => {
        if (p) upsertPlan(p)
      })
      .finally(() => setLoading(false))
  }, [slug, plan, loading, upsertPlan])

  if (!plan) {
    return (
      <div className="flex-1 flex items-center justify-center text-klenny-muted text-sm">
        {loading ? 'Loading plan…' : 'Plan not found.'}
      </div>
    )
  }

  // Prefer the tab that created this plan; fall back to whichever chat tab is currently active.
  const originTabId = openTab?.originTabId && tabs.some((t) => t.id === openTab.originTabId) ? openTab.originTabId : activeTabId

  const approve = async () => {
    if (!originTabId || approving) return
    setApproving(true)
    try {
      await window.klenny.approvePlan(slug, originTabId)
      setActiveTab(originTabId)
      closePlanTab(slug)
      // Deliberately no setTabs(await listTabs()) here — the main process already emits a
      // 'tab_upserted' event (with the new checklist + user messages, mode switched to agent)
      // as part of approvePlan itself. Calling listTabs() again here would race against that
      // event and could overwrite the fresh checklist data with a stale snapshot fetched before
      // the emit landed in the store.
    } finally {
      setApproving(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="px-4 py-2 border-b border-klenny-border flex items-center justify-between bg-klenny-panel">
        <div className="text-sm text-klenny-muted">
          Plan · saved {new Date(plan.createdAt).toLocaleString()}
        </div>
        <div className="flex gap-2">
          <button
            className="px-3 py-1.5 rounded-md bg-klenny-accent text-black text-sm font-medium hover:bg-klenny-accent2 disabled:opacity-50"
            disabled={!originTabId || approving}
            title={originTabId ? undefined : 'No chat tab to switch to'}
            onClick={() => void approve()}
          >
            {approving ? 'Approving…' : 'Approve & switch to Agent mode'}
          </button>
          <button
            className="px-3 py-1.5 rounded-md border border-klenny-border text-sm hover:bg-klenny-panel2"
            onClick={() => closePlanTab(slug)}
          >
            Close
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-3xl mx-auto markdown prose prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.markdown}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
