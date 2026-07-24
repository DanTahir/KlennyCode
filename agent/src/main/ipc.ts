import { app, BrowserWindow, ipcMain, shell, Menu, nativeImage } from 'electron'
import { join } from 'node:path'
import { checkForUpdates, installUpdate, isUpdateSupported } from './updater'
import { IPC } from '@shared/ipc'
import { loadSettings, saveSettings, setApiKey, clearApiKey, setPineconeKey, clearPineconeKey } from './settings'
import { getWorkspace, pickWorkspace, setWorkspace } from './workspace'
import { sessionStore } from './session/store'
import { fetchModels } from './openrouter/client'
import { runUserTurn, stopGeneration, resolveQuestion, continueTurn, clearTabState } from './agent/orchestrator'
import { approvalManager } from './agent/approval/manager'
import { listSkills, readSkill, writeSkill } from './agent/skills/manager'
import { listSubagentTypes, writeSubagentType } from './agent/subagents/manager'
import { listPlans, readPlan } from './agent/plan/manager'
import { readMemoryFile, writeMemoryFile } from './agent/memory/manager'
import { readSoul, writeSoul, resetSoul } from './agent/soul/manager'
import { getApiKey } from './settings'
import { detectShells } from './shells'
import { createTerminal, writeTerminal, resizeTerminal, disposeTerminal, setTerminalListeners } from './terminal'
import { startIndexing, stopIndexing, getIndexStatus, rebuildIndex, deleteLocalIndex, setOnStatusChange } from './agent/codeindex/manager'
import { getCostReport, resetCostReport } from './agent/costReport'
import type { AgentStreamEvent, IndexStatus, ScheduledTask, TabApprovalMode } from '@shared/types'
import { DEFAULT_BRAND_NAME } from '@shared/types'
import { createTray, wireMinimizeToTray, refreshMinimizeToTrayCache, applyAutoStartSetting, refreshTrayIcon } from './tray'
import { connectGmail, disconnectGmail } from './integrations/gmail'
import { connectDiscord, disconnectDiscord, getDiscordStatus, onDiscordStatusChange } from './integrations/discord'
import { scheduledTaskManager } from './scheduler/manager'
import {
  getCustomIconDataUrl,
  setCustomIcon as saveCustomIcon,
  clearCustomIcon,
  getCustomRunningGifDataUrl,
  setCustomRunningGif as saveCustomRunningGif,
  clearCustomRunningGif,
  resolveActiveIconPath
} from './branding'

function broadcast(event: AgentStreamEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream', event)
  }
}

function broadcastTerminalData(id: string, data: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('terminal:data', id, data)
  }
}

function broadcastTerminalExit(id: string, exitCode: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('terminal:exit', id, exitCode)
  }
}

/** Applies the current icon (custom if set, otherwise the bundled default) and the
 *  version-suffixed window title (using the custom brand name if set) to every open window —
 *  called at startup and whenever the user changes either in Settings → Appearance. */
async function applyBrandingToAllWindows(): Promise<void> {
  const [iconPath, settings] = await Promise.all([resolveActiveIconPath(), loadSettings()])
  const image = nativeImage.createFromPath(iconPath)
  const title = `${settings.brandName || DEFAULT_BRAND_NAME} ${app.getVersion()}`
  for (const win of BrowserWindow.getAllWindows()) {
    if (!image.isEmpty()) win.setIcon(image)
    win.setTitle(title)
  }
  // Windows/Linux taskbar icon comes from BrowserWindow.setIcon above; macOS dock icon is
  // separate and needs app.dock.setIcon (undefined on non-macOS platforms).
  if (!image.isEmpty()) app.dock?.setIcon(image)
  await refreshTrayIcon()
}

/** Fire-and-forget: resolves the current settings + model catalog and (re)starts the codebase index for `root`, or stops it if the feature isn't fully configured. Never throws into the caller — indexing failures surface via index_progress status, not a rejected promise on workspace open. Exported so main/index.ts can trigger it for the auto-restored last-opened workspace on app launch. */
export async function refreshIndexingForWorkspace(root: string): Promise<void> {
  try {
    const settings = await loadSettings()
    if (!settings.codebaseIndexEnabled || !settings.embeddingsModel) {
      await stopIndexing()
      return
    }
    const key = await getApiKey()
    const models = key ? await fetchModels(key, false) : []
    await startIndexing(root, settings, models)
  } catch (e) {
    console.error('Failed to start codebase index for workspace:', e)
  }
}

export function registerIpcHandlers(): void {
  setOnStatusChange((status: IndexStatus) =>
    broadcast({
      type: 'index_progress',
      phase: status.phase,
      filesTotal: status.filesTotal,
      filesDone: status.filesDone,
      message: status.message
    })
  )

  ipcMain.handle(IPC.settingsGet, async () => loadSettings())
  ipcMain.handle(IPC.settingsSet, async (_e, patch) => {
    const next = await saveSettings(patch)
    approvalManager.setMode(next.approvalMode)
    // Only re-evaluate indexing if a codebase-index-relevant field actually changed —
    // this handler fires on every settings save (theme, spending cap, etc.), and
    // restarting the watcher/scan on unrelated changes would be wasteful and could
    // interrupt an in-progress scan for no reason.
    const relevantKeys: Array<keyof typeof patch> = [
      'codebaseIndexEnabled',
      'embeddingsModel',
      'vectorStoreBackend',
      'pineconeIndexName'
    ]
    if (relevantKeys.some((k) => k in patch)) {
      const ws = getWorkspace()
      if (ws) void refreshIndexingForWorkspace(ws)
    }
    if ('minimizeToTray' in patch) await refreshMinimizeToTrayCache()
    if ('startOnLogin' in patch) await applyAutoStartSetting(next.startOnLogin)
    if ('brandName' in patch) await applyBrandingToAllWindows()
    return next
  })
  ipcMain.handle(IPC.setApiKey, async (_e, key: string) => setApiKey(key))
  ipcMain.handle(IPC.clearApiKey, async () => clearApiKey())

  ipcMain.handle(IPC.workspaceOpen, async () => {
    const path = await pickWorkspace()
    if (path) {
      setWorkspace(path)
      await saveSettings({ lastWorkspace: path })
      await sessionStore.load(path)
      await approvalManager.init(path)
      void refreshIndexingForWorkspace(path)
    }
    return path
  })
  ipcMain.handle(IPC.workspaceGet, async () => getWorkspace())

  ipcMain.handle(IPC.modelsList, async (_e, force?: boolean) => {
    const key = await getApiKey()
    if (!key) return []
    return fetchModels(key, force)
  })
  ipcMain.handle(IPC.shellsList, async () => detectShells())

  setTerminalListeners(broadcastTerminalData, broadcastTerminalExit)
  ipcMain.handle(IPC.terminalCreate, async (_e, cols: number, rows: number) => {
    const settings = await loadSettings()
    const cwd = getWorkspace() ?? process.cwd()
    const session = createTerminal({ shellId: settings.shellId, cwd, cols, rows })
    return { id: session.id, shellName: session.shell.name }
  })
  ipcMain.handle(IPC.terminalWrite, async (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.handle(IPC.terminalResize, async (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.handle(IPC.terminalDispose, async (_e, id: string) => disposeTerminal(id))

  ipcMain.handle(IPC.tabsList, async () => {
    const tabs = sessionStore.getTabs()
    if (!tabs.length) return [await sessionStore.createTab()]
    return tabs
  })
  ipcMain.handle(IPC.tabCreate, async () => sessionStore.createTab())
  ipcMain.handle(IPC.tabCreateAssistant, async () => sessionStore.createAssistantTab())
  ipcMain.handle(IPC.tabClose, async (_e, tabId: string) => {
    // Abort any in-flight turn/questions for this tab and drop its per-tab bookkeeping from
    // the orchestrator's module-level maps — otherwise it leaks for the lifetime of the app
    // (see clearTabState doc comment).
    clearTabState(tabId)
    approvalManager.clearTab(tabId)
    return sessionStore.closeTab(tabId)
  })
  ipcMain.handle(IPC.tabSetMode, async (_e, tabId: string, mode: 'agent' | 'plan') => {
    const tab = sessionStore.getTab(tabId)
    if (tab) {
      tab.mode = mode
      await sessionStore.updateTab(tab)
    }
  })
  ipcMain.handle(IPC.tabSetModel, async (_e, tabId: string, model: string) => {
    const tab = sessionStore.getTab(tabId)
    if (tab) {
      tab.model = model
      await sessionStore.updateTab(tab)
    }
  })
  ipcMain.handle(IPC.tabSetApprovalMode, async (_e, tabId: string, mode: TabApprovalMode) => {
    const tab = sessionStore.getTab(tabId)
    if (tab) {
      tab.approvalMode = mode
      // Leaving 'auto' should stop auto-accepting anything still queued for this tab from an
      // earlier "Accept all" click or dropdown selection; only 'auto' itself should keep it on.
      approvalManager.setTabAcceptAll(tabId, mode === 'auto')
      await sessionStore.updateTab(tab)
    }
  })

  ipcMain.handle(IPC.historyList, async () => sessionStore.getHistory())
  ipcMain.handle(IPC.historyReopen, async (_e, tabId: string) => sessionStore.reopenHistoryEntry(tabId))
  ipcMain.handle(IPC.historyDelete, async (_e, tabId: string) => sessionStore.deleteHistoryEntry(tabId))

  ipcMain.handle(IPC.sendMessage, async (_e, payload) => {
    void runUserTurn(payload.tabId, payload.text, payload.images)
  })
  ipcMain.handle(IPC.stopGeneration, async (_e, tabId: string) => stopGeneration(tabId))
  ipcMain.handle(IPC.continueTurn, async (_e, tabId: string) => {
    void continueTurn(tabId)
  })

  ipcMain.handle(IPC.resolveApproval, async (_e, actionId: string, decision) => {
    // Capture the tabId before resolve() removes the pending action from the map.
    const tabId = approvalManager.getPending().find((a) => a.id === actionId)?.tabId
    approvalManager.resolve(actionId, decision)
    if (decision === 'accept_all' && tabId) {
      // Reflect the accept-all in the tab's own approval-mode dropdown (so it visibly flips to
      // "Auto approve"), not just in ApprovalManager's internal accept-all set.
      const tab = sessionStore.getTab(tabId)
      if (tab) {
        tab.approvalMode = 'auto'
        await sessionStore.updateTab(tab)
        broadcast({ type: 'tab_upserted', tab })
      }
    }
  })
  ipcMain.handle(IPC.resolveQuestion, async (_e, questionId: string, answers) => {
    resolveQuestion(questionId, answers)
  })

  ipcMain.handle(IPC.skillsList, async () => listSkills())
  ipcMain.handle(IPC.skillRead, async (_e, path: string) => readSkill(path))
  ipcMain.handle(IPC.skillWrite, async (_e, name, scope, description, body) =>
    writeSkill(name, scope, description, body)
  )

  ipcMain.handle(IPC.subagentsList, async () => listSubagentTypes())
  ipcMain.handle(IPC.subagentWrite, async (_e, name, scope, description, tools, model, body) =>
    writeSubagentType(name, scope, description, tools, model, body)
  )

  ipcMain.handle(IPC.plansList, async () => listPlans())
  ipcMain.handle(IPC.planRead, async (_e, slug: string) => readPlan(slug))

  ipcMain.handle(IPC.memoryRead, async (_e, scope: 'project' | 'global') => readMemoryFile(scope))
  ipcMain.handle(IPC.memoryWrite, async (_e, scope: 'project' | 'global', content: string) =>
    writeMemoryFile(scope, content)
  )

  ipcMain.handle(IPC.soulRead, async () => readSoul())
  ipcMain.handle(IPC.soulWrite, async (_e, content: string) => writeSoul(content))
  ipcMain.handle(IPC.soulReset, async () => resetSoul())

  ipcMain.handle(IPC.checkpointRevert, async () => {
    // best-effort placeholder — full shadow revert can be expanded later
    return
  })

  ipcMain.handle(IPC.pineconeSetKey, async (_e, key: string) => setPineconeKey(key))
  ipcMain.handle(IPC.pineconeClearKey, async () => clearPineconeKey())
  ipcMain.handle(IPC.indexRebuild, async () => {
    const ws = getWorkspace()
    if (!ws) return
    const settings = await loadSettings()
    const key = await getApiKey()
    const models = key ? await fetchModels(key, false) : []
    await rebuildIndex(ws, settings, models)
  })
  ipcMain.handle(IPC.indexDelete, async () => {
    const ws = getWorkspace()
    if (!ws) return
    await deleteLocalIndex(ws)
  })
  ipcMain.handle(IPC.indexStatus, async () => getIndexStatus())

  ipcMain.handle(IPC.appVersion, async () => app.getVersion())
  ipcMain.handle(IPC.updateSupported, async () => isUpdateSupported())
  ipcMain.handle(IPC.checkForUpdates, async () => checkForUpdates())
  ipcMain.handle(IPC.installUpdate, async () => installUpdate())

  ipcMain.handle(IPC.costReportGet, async () => getCostReport(getWorkspace()))
  ipcMain.handle(IPC.costReportReset, async () => {
    await resetCostReport()
    return getCostReport(getWorkspace())
  })

  ipcMain.handle(IPC.gmailConnect, async () => connectGmail())
  ipcMain.handle(IPC.gmailDisconnect, async () => disconnectGmail())

  ipcMain.handle(IPC.discordConnect, async (_e, botToken: string) => connectDiscord(botToken))
  ipcMain.handle(IPC.discordDisconnect, async () => disconnectDiscord())
  ipcMain.handle(IPC.discordStatusGet, async () => getDiscordStatus())
  onDiscordStatusChange((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.onDiscordStatus, status)
    }
  })

  ipcMain.handle(IPC.schedulerList, async () => scheduledTaskManager.list())
  ipcMain.handle(
    IPC.schedulerCreate,
    async (
      _e,
      task: Pick<ScheduledTask, 'name' | 'prompt' | 'schedule' | 'targetWorkspace' | 'maxCostUsd'> &
        Partial<Pick<ScheduledTask, 'maxRuns'>>
    ) => scheduledTaskManager.create(task)
  )
  ipcMain.handle(IPC.schedulerUpdate, async (_e, id: string, patch: Partial<ScheduledTask>) => scheduledTaskManager.update(id, patch))
  ipcMain.handle(IPC.schedulerDelete, async (_e, id: string) => scheduledTaskManager.delete(id))

  ipcMain.handle(IPC.brandingGetIcon, async () => getCustomIconDataUrl())
  ipcMain.handle(IPC.brandingSetIcon, async (_e, dataUrl: string) => {
    await saveCustomIcon(dataUrl)
    await applyBrandingToAllWindows()
    return loadSettings()
  })
  ipcMain.handle(IPC.brandingClearIcon, async () => {
    await clearCustomIcon()
    await applyBrandingToAllWindows()
    return loadSettings()
  })
  ipcMain.handle(IPC.brandingGetRunningGif, async () => getCustomRunningGifDataUrl())
  ipcMain.handle(IPC.brandingSetRunningGif, async (_e, dataUrl: string) => {
    await saveCustomRunningGif(dataUrl)
    return loadSettings()
  })
  ipcMain.handle(IPC.brandingClearRunningGif, async () => {
    await clearCustomRunningGif()
    return loadSettings()
  })
  ipcMain.handle(IPC.brandingResetAll, async () => {
    await clearCustomIcon()
    await clearCustomRunningGif()
    const next = await saveSettings({ brandName: null })
    await applyBrandingToAllWindows()
    return next
  })
}

export function createMainWindow(): BrowserWindow {
  Menu.setApplicationMenu(null)

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: `${DEFAULT_BRAND_NAME} ${app.getVersion()}`,
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icons/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Swap in the user's custom icon/brand name (if any) once settings/branding files are
  // readable — the synchronous options above only cover the default, first-paint case.
  void applyBrandingToAllWindows()

  win.on('ready-to-show', () => win.show())
  wireMinimizeToTray(win)

  // The renderer's <title> would otherwise overwrite our version-suffixed title on load.
  win.on('page-title-updated', (e) => e.preventDefault())

  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error('Preload failed:', preloadPath, error)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer process gone:', details)
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error('Renderer failed to load:', code, desc)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}
