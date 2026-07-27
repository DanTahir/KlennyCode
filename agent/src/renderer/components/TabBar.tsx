import { useAppStore } from '../store/useAppStore'
import { useCodeTabActions } from '../hooks/useCodeTabActions'
import { useAssistantTabActions } from '../hooks/useAssistantTabActions'

export function TabBar() {
  const { tabs, activeTabId, setTabs, setActiveTab, plans, openPlanTabs, activePlanSlug, closePlanTab, openPlanTab } =
    useAppStore()
  const { openCodeTab } = useCodeTabActions()
  const { openAssistantTab } = useAssistantTabActions()

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-klenny-border bg-klenny-panel overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-t-md text-sm cursor-pointer ${
            !activePlanSlug && tab.id === activeTabId
              ? 'bg-klenny-bg border border-b-0 border-klenny-border'
              : 'hover:bg-klenny-panel2'
          }`}
          onClick={() => setActiveTab(tab.id)}
        >
          <span className="truncate max-w-[140px]">
            {tab.kind === 'assistant' ? '🐾 ' : '💻 '}
            {tab.title}
          </span>
          <button
            className="text-klenny-muted hover:text-klenny-text"
            onClick={(e) => {
              e.stopPropagation()
              void window.klenny.closeTab(tab.id).then(setTabs)
            }}
          >
            ×
          </button>
        </div>
      ))}
      {openPlanTabs.map((pt) => {
        const plan = plans.find((p) => p.slug === pt.slug)
        return (
          <div
            key={`plan:${pt.slug}`}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-t-md text-sm cursor-pointer ${
              activePlanSlug === pt.slug
                ? 'bg-klenny-bg border border-b-0 border-klenny-accent/50'
                : 'hover:bg-klenny-panel2'
            }`}
            onClick={() => openPlanTab(pt.slug, pt.originTabId)}
          >
            <span className="truncate max-w-[160px]" title={plan?.title ?? pt.slug}>
              📝 {plan?.title ?? pt.slug}
            </span>
            <button
              className="text-klenny-muted hover:text-klenny-text"
              onClick={(e) => {
                e.stopPropagation()
                closePlanTab(pt.slug)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
      <button
        className="flex items-center px-2 py-1 text-klenny-muted hover:text-klenny-text"
        title="New Code Chat tab (Ctrl+T)"
        onClick={() => void openCodeTab()}
      >
        💻+
      </button>
      <button
        className="flex items-center px-2 py-1 text-klenny-muted hover:text-klenny-text"
        title="New Assistant tab"
        onClick={() => void openAssistantTab()}
      >
        🐾+
      </button>
    </div>
  )
}
