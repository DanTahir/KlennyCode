import klennyImg from '../assets/klenny.jpg'
import { useAppStore } from '../store/useAppStore'
import { useWorkspaceActions } from '../hooks/useWorkspaceActions'

const items = [
  { id: 'chat', label: 'Chat' },
  { id: 'plans', label: 'Plans' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' }
] as const

export function Sidebar() {
  const { panel, setPanel, workspace } = useAppStore()
  const { openWorkspace } = useWorkspaceActions()

  return (
    <aside className="w-52 border-r border-klenny-border bg-klenny-panel flex flex-col">
      <div className="p-3 border-b border-klenny-border flex items-center gap-2">
        <img src={klennyImg} alt="Klenny Code" className="w-10 h-10 rounded-full object-cover" />
        <span className="font-semibold text-sm text-klenny-accent">Klenny Code</span>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => setPanel(item.id)}
            className={`w-full text-left px-3 py-2 rounded-md text-sm ${
              panel === item.id ? 'bg-klenny-panel2 text-klenny-accent' : 'hover:bg-klenny-panel2'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="p-3 border-t border-klenny-border space-y-2">
        {workspace && (
          <div className="text-[10px] text-klenny-muted truncate px-1" title={workspace}>
            {workspace.split(/[/\\]/).pop()}
          </div>
        )}
        <button
          className="w-full text-sm px-3 py-2 rounded-md bg-klenny-accent text-black font-medium hover:bg-klenny-accent2"
          onClick={() => void openWorkspace()}
        >
          {workspace ? 'Change project' : 'Open project folder'}
        </button>
      </div>
    </aside>
  )
}
