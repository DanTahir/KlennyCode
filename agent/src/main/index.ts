import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { createMainWindow, registerIpcHandlers, refreshIndexingForWorkspace } from './ipc'
import { initAutoUpdater } from './updater'
import { loadSettings } from './settings'
import { setWorkspace } from './workspace'
import { sessionStore } from './session/store'
import { approvalManager } from './agent/approval/manager'
import { stopIndexing } from './agent/codeindex/manager'
import { disposeAllTerminals } from './terminal'
import { disposeAllSessions as disposeAllBrowserSessions } from './browser/manager'
import { createTray, refreshMinimizeToTrayCache, applyAutoStartSetting } from './tray'
import { scheduledTaskManager } from './scheduler/manager'
import { runScheduledTask } from './agent/orchestrator'
import { startDiscordClient, stopDiscordClient, setInboundCommandHandler } from './integrations/discord'
import { runInboundDiscordCommand } from './agent/discordBridge'

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.dantahir.klenny')
  }
  registerIpcHandlers()

  const settings = await loadSettings()
  // Assistant tabs are workspace-independent and persist across restarts — load them before any
  // workspace-scoped session load, and even if no workspace is ever opened (see
  // SessionStore.loadAssistantTabs doc comment).
  await sessionStore.loadAssistantTabs()
  if (settings.lastWorkspace && existsSync(settings.lastWorkspace)) {
    setWorkspace(settings.lastWorkspace)
    await sessionStore.load(settings.lastWorkspace)
    await approvalManager.init(settings.lastWorkspace)
    void refreshIndexingForWorkspace(settings.lastWorkspace)
  }

  await refreshMinimizeToTrayCache()
  await applyAutoStartSetting(settings.startOnLogin)

  createMainWindow()
  void createTray(() => BrowserWindow.getAllWindows()[0] ?? null)

  // Personal Assistant Platform (Phase 4): scheduler + Discord gateway run for the lifetime of
  // the app/tray process, independent of any specific chat tab.
  scheduledTaskManager.setRunner(runScheduledTask)
  await scheduledTaskManager.load()
  scheduledTaskManager.startTicking()
  setInboundCommandHandler(runInboundDiscordCommand)
  void startDiscordClient()

  initAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void stopIndexing()
  disposeAllTerminals()
  void disposeAllBrowserSessions()
  scheduledTaskManager.stopTicking()
  void stopDiscordClient()
})
