import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppStore } from '../store/useAppStore'
import type { PlanArtifact } from '@shared/types'

/** Full-page view of a single plan, rendered as its own tab in the main tab bar. */
export function PlanTabView({ slug }: { slug: string }) {
  const { plans, upsertPlan, openPlanTabs, tabs, activeTabId, setTabs, setActiveTab, closePlanTab } = useAppStore()
  const [loading, setLoading] = useState(false)

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
    if (!originTabId) return
    await window.klenny.setTabMode(originTabId, 'agent')
    setTabs(await window.klenny.listTabs())
    setActiveTab(originTabId)
    await window.klenny.sendMessage({
      tabId: originTabId,
      text: `The following plan has been approved. Implement it now.\n\n# ${plan.title}\n\n${plan.markdown}`
    })
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
            disabled={!originTabId}
            title={originTabId ? undefined : 'No chat tab to switch to'}
            onClick={() => void approve()}
          >
            Approve &amp; switch to Agent mode
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
