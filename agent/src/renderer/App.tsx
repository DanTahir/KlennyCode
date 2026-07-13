import { useEffect, useState } from 'react'
import { useAppStore } from './store/useAppStore'
import { useWorkspaceActions } from './hooks/useWorkspaceActions'
import { Sidebar } from './components/Sidebar'
import { TabBar } from './components/TabBar'
import { ChatPane } from './components/ChatPane'
import { WelcomeScreen } from './components/WelcomeScreen'
import { SettingsPanel } from './components/SettingsPanel'
import { CostReportPanel } from './components/CostReportPanel'
import { HelpPanel } from './components/HelpPanel'
import { SkillsPanel } from './components/SkillsPanel'
import { MemoryPanel } from './components/MemoryPanel'
import { PlansPanel } from './components/PlansPanel'
import { PlanTabView } from './components/PlanTabView'
import { HistoryPanel } from './components/HistoryPanel'
import { SubagentPanel } from './components/SubagentPanel'
import { TerminalPanel } from './components/TerminalPanel'

export default function App() {
  const {
    settings,
    workspace,
    tabs,
    activeTabId,
    panel,
    activePlanSlug,
    setSettings,
    setWorkspace,
    setModels,
    setTabs,
    setActiveTab,
    applyStreamEvent,
    setSkills,
    setPlans,
    setUpdateStatus,
    setUpdateSupported
  } = useAppStore()

  const { openWorkspace } = useWorkspaceActions()
  const [ready, setReady] = useState(false)
  const needsSetup = !workspace || !settings?.hasApiKey

  useEffect(() => {
    if (settings?.theme === 'light') {
      document.documentElement.classList.remove('dark')
    } else {
      document.documentElement.classList.add('dark')
    }
  }, [settings?.theme])

  useEffect(() => {
    document.documentElement.classList.add('dark')
    if (!window.klenny) {
      console.error('Preload bridge missing — window.klenny is undefined')
      setReady(true)
      return
    }
    void (async () => {
      const [s, ws, modelList, tabList, skills, plans, updateSupported] = await Promise.all([
        window.klenny.getSettings(),
        window.klenny.getWorkspace(),
        window.klenny.listModels().catch(() => []),
        window.klenny.listTabs(),
        window.klenny.listSkills().catch(() => []),
        window.klenny.listPlans().catch(() => []),
        window.klenny.isUpdateSupported().catch(() => false)
      ])
      setSettings(s)
      setWorkspace(ws)
      setModels(modelList)
      setTabs(tabList)
      if (tabList[0]) setActiveTab(tabList[0].id)
      setSkills(skills)
      setPlans(plans)
      setUpdateSupported(updateSupported)
      setReady(true)

      if (!ws && !s.hasApiKey) {
        useAppStore.getState().setPanel('chat')
      }
    })()

    const unsub = window.klenny.onStreamEvent((e) => applyStreamEvent(e as never))
    const unsubUpdate = window.klenny.onUpdateStatus((e) => setUpdateStatus(e))
    return () => {
      unsub()
      unsubUpdate()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 't') {
        e.preventDefault()
        void window.klenny.createTab().then(async (tab) => {
          setTabs(await window.klenny.listTabs())
          setActiveTab(tab.id)
        })
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w' && activeTabId) {
        e.preventDefault()
        void window.klenny.closeTab(activeTabId).then(setTabs)
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '`') {
        e.preventDefault()
        useAppStore.getState().toggleTerminal()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTabId])

  if (!ready) {
    return (
      <div className="h-screen flex items-center justify-center bg-klenny-bg text-klenny-muted">
        Loading Klenny Code…
      </div>
    )
  }

  if (!window.klenny) {
    return (
      <div className="h-screen flex items-center justify-center bg-klenny-bg text-klenny-text p-8">
        <div className="max-w-md text-center space-y-3">
          <h1 className="text-xl font-semibold text-klenny-accent">Failed to start Klenny Code</h1>
          <p className="text-sm text-klenny-muted">
            The app UI could not connect to the main process. Try rebuilding with{' '}
            <code className="text-klenny-accent">npm run dist:dir</code> from the agent folder.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex bg-klenny-bg text-klenny-text">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <header className="h-12 border-b border-klenny-border flex items-center px-4 justify-between bg-klenny-panel">
          <div className="font-semibold text-klenny-accent">Klenny Code</div>
          <button
            type="button"
            className="text-xs text-klenny-muted truncate max-w-[50%] hover:text-klenny-accent underline-offset-2 hover:underline"
            onClick={() => void openWorkspace()}
            title="Click to open or change project folder"
          >
            {workspace ?? 'No project open — click here to open a folder'}
          </button>
        </header>
        {panel === 'chat' && (
          <>
            <TabBar />
            {activePlanSlug ? (
              <PlanTabView slug={activePlanSlug} />
            ) : (
              <div className="flex flex-1 flex-col min-h-0">
                {needsSetup && (
                  <WelcomeScreen
                    onOpenWorkspace={() => void openWorkspace()}
                    onOpenSettings={() => useAppStore.getState().setPanel('settings')}
                  />
                )}
                <div className={`flex flex-1 min-h-0 ${needsSetup ? 'max-h-[45%] border-t border-klenny-border' : ''}`}>
                  <ChatPane />
                  <SubagentPanel />
                </div>
              </div>
            )}
          </>
        )}
        {panel === 'settings' && <SettingsPanel />}
        {panel === 'cost-report' && <CostReportPanel />}
        {panel === 'help' && <HelpPanel />}
        {panel === 'skills' && <SkillsPanel />}
        {panel === 'memory' && <MemoryPanel />}
        {panel === 'plans' && <PlansPanel />}
        {panel === 'history' && <HistoryPanel />}
        <TerminalPanel />
      </div>
    </div>
  )
}
