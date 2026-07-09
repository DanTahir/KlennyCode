import { useAppStore } from '../store/useAppStore'

export function TabBar() {
  const { tabs, activeTabId, setTabs, setActiveTab } = useAppStore()

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-klenny-border bg-klenny-panel overflow-x-auto">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-t-md text-sm cursor-pointer ${
            tab.id === activeTabId ? 'bg-klenny-bg border border-b-0 border-klenny-border' : 'hover:bg-klenny-panel2'
          }`}
          onClick={() => setActiveTab(tab.id)}
        >
          <span className="truncate max-w-[140px]">{tab.title}</span>
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
      <button
        className="px-2 py-1 text-klenny-muted hover:text-klenny-text"
        title="New tab (Ctrl+T)"
        onClick={() => void window.klenny.createTab().then(() => window.klenny.listTabs().then(setTabs))}
      >
        +
      </button>
    </div>
  )
}
