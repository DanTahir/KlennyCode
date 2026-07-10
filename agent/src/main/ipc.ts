import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
import { IPC } from '@shared/ipc'
import { loadSettings, saveSettings, setApiKey, clearApiKey } from './settings'
import { getWorkspace, pickWorkspace, setWorkspace } from './workspace'
import { sessionStore } from './session/store'
import { fetchModels } from './openrouter/client'
import { runUserTurn, stopGeneration, resolveQuestion } from './agent/orchestrator'
import { approvalManager } from './agent/approval/manager'
import { listSkills, readSkill, writeSkill } from './agent/skills/manager'
import { listSubagentTypes, writeSubagentType } from './agent/subagents/manager'
import { listPlans, readPlan } from './agent/plan/manager'
import { readMemoryFile, writeMemoryFile } from './agent/memory/manager'
import { getApiKey } from './settings'
import { detectShells } from './shells'

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC.settingsGet, async () => loadSettings())
  ipcMain.handle(IPC.settingsSet, async (_e, patch) => {
    const next = await saveSettings(patch)
    approvalManager.setMode(next.approvalMode)
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

  ipcMain.handle(IPC.tabsList, async () => {
    const tabs = sessionStore.getTabs()
    if (!tabs.length) return [await sessionStore.createTab()]
    return tabs
  })
  ipcMain.handle(IPC.tabCreate, async () => sessionStore.createTab())
  ipcMain.handle(IPC.tabClose, async (_e, tabId: string) => sessionStore.closeTab(tabId))
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

  ipcMain.handle(IPC.sendMessage, async (_e, payload) => {
    void runUserTurn(payload.tabId, payload.text, payload.images)
  })
  ipcMain.handle(IPC.stopGeneration, async (_e, tabId: string) => stopGeneration(tabId))

  ipcMain.handle(IPC.resolveApproval, async (_e, actionId: string, decision) => {
    approvalManager.resolve(actionId, decision)
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

  ipcMain.handle(IPC.checkpointRevert, async () => {
    // best-effort placeholder — full shadow revert can be expanded later
    return
  })

  ipcMain.handle(IPC.appVersion, async () => app.getVersion())
  ipcMain.handle(IPC.checkForUpdates, async () => {
    if (!app.isPackaged) return
    await autoUpdater.checkForUpdatesAndNotify()
  })
}

export function createMainWindow(): BrowserWindow {
  Menu.setApplicationMenu(null)

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Klenny Code',
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

  win.on('ready-to-show', () => win.show())

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
