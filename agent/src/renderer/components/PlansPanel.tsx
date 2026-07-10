import { useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppStore } from '../store/useAppStore'
import { PlanViewer } from './PlanViewer'

export function PlansPanel() {
  const { plans, setPlans, activeTabId, setTabs, setPanel } = useAppStore()

  useEffect(() => {
    void window.klenny.listPlans().then(setPlans)
  }, [])

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <h2 className="text-xl font-semibold">Plans</h2>
      {plans.length === 0 && <p className="text-klenny-muted text-sm">No plans yet. Use Plan mode in chat to create one.</p>}
      {plans.map((p) => (
        <PlanViewer
          key={p.slug}
          plan={p}
          onApprove={async () => {
            if (!activeTabId) return
            await window.klenny.setTabMode(activeTabId, 'agent')
            setTabs(await window.klenny.listTabs())
            setPanel('chat')
            await window.klenny.sendMessage({
              tabId: activeTabId,
              text: `The following plan has been approved. Implement it now.\n\n# ${p.title}\n\n${p.markdown}`
            })
          }}
        />
      ))}
    </div>
  )
}
