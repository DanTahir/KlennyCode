import { useEffect, useState } from 'react'
import klennyImg from '../assets/klenny.jpg'
import { useAppStore } from '../store/useAppStore'
import { useWorkspaceActions } from '../hooks/useWorkspaceActions'
import { useAssistantTabActions } from '../hooks/useAssistantTabActions'

const items = [
  { id: 'chat', label: 'Chat' },
  { id: 'plans', label: 'Plans' },
  { id: 'history', label: 'History' },
  { id: 'skills', label: 'Skills' },
  { id: 'memory', label: 'Memory' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' }
] as const

export function Sidebar() {
  const { panel, setPanel, workspace, updateStatus, updateSupported } = useAppStore()
  const { openWorkspace } = useWorkspaceActions()
  const { openAssistantTab } = useAssistantTabActions()
  const [justChecked, setJustChecked] = useState<'up-to-date' | 'error' | null>(null)

  useEffect(() => {
    if (updateStatus?.status === 'not-available') {
      setJustChecked('up-to-date')
    } else if (updateStatus?.status === 'error') {
      setJustChecked('error')
    } else if (updateStatus?.status === 'checking' || updateStatus?.status === 'downloading') {
      setJustChecked(null)
    }
  }, [updateStatus])

  useEffect(() => {
    if (!justChecked) return
    const t = setTimeout(() => setJustChecked(null), 4000)
    return () => clearTimeout(t)
  }, [justChecked])

  const checking = updateStatus?.status === 'checking'
  const downloading = updateStatus?.status === 'downloading'
  const downloaded = updateStatus?.status === 'downloaded'

  let checkLabel = 'Check for update'
  if (checking) checkLabel = 'Checking…'
  else if (downloading) checkLabel = `Downloading… ${Math.round(updateStatus?.percent ?? 0)}%`
  else if (justChecked === 'up-to-date') checkLabel = "You're up to date"
  else if (justChecked === 'error') checkLabel = 'Check failed — try again'

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
        {updateSupported &&
          (downloaded ? (
            <button
              className="w-full text-xs px-3 py-2 rounded-md bg-klenny-accent2 text-black font-medium hover:opacity-90"
              onClick={() => void window.klenny.installUpdate()}
              title={`Version ${updateStatus?.version} is ready`}
            >
              Restart to update{updateStatus?.version ? ` (v${updateStatus.version})` : ''}
            </button>
          ) : (
            <button
              className="w-full text-xs px-3 py-2 rounded-md border border-klenny-border text-klenny-muted hover:text-klenny-accent hover:border-klenny-accent disabled:opacity-60 disabled:cursor-default"
              onClick={() => void window.klenny.checkForUpdates()}
              disabled={checking || downloading}
            >
              {checkLabel}
            </button>
          ))}
        <button
          className="w-full text-xs px-3 py-2 rounded-md border border-klenny-border text-klenny-muted hover:text-klenny-accent hover:border-klenny-accent"
          title="Open a new Assistant tab (Gmail, Discord, scheduler, web search — no coding project needed)"
          onClick={() => void openAssistantTab()}
        >
          Open Assistant
        </button>
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
