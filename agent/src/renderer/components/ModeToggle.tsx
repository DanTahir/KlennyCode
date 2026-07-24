import { useAppStore } from '../store/useAppStore'

export function ModeToggle({
  tabId,
  mode,
  model,
  kind
}: {
  tabId: string
  mode: 'agent' | 'plan'
  model: string
  kind?: 'project' | 'assistant'
}) {
  const { models, setTabs } = useAppStore()

  return (
    <div className="flex items-center gap-3 text-sm">
      {kind !== 'assistant' && (
        <div className="flex rounded-md border border-klenny-border overflow-hidden">
          {(['agent', 'plan'] as const).map((m) => (
            <button
              key={m}
              className={`px-3 py-1 capitalize ${mode === m ? 'bg-klenny-accent text-black' : 'hover:bg-klenny-panel2'}`}
              onClick={() => void window.klenny.setTabMode(tabId, m).then(() => window.klenny.listTabs().then(setTabs))}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      <select
        className="bg-klenny-bg border border-klenny-border rounded px-2 py-1 text-xs max-w-[220px]"
        value={model}
        onChange={(e) => void window.klenny.setTabModel(tabId, e.target.value).then(() => window.klenny.listTabs().then(setTabs))}
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.pinned ? '★ ' : ''}{m.name}
          </option>
        ))}
      </select>
    </div>
  )
}
