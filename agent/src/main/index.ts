import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { createMainWindow, registerIpcHandlers } from './ipc'
import { initAutoUpdater } from './updater'
import { loadSettings } from './settings'
import { setWorkspace } from './workspace'
import { sessionStore } from './session/store'
import { approvalManager } from './agent/approval/manager'

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.dantahir.klenny')
  }
  registerIpcHandlers()

  const settings = await loadSettings()
  if (settings.lastWorkspace && existsSync(settings.lastWorkspace)) {
    setWorkspace(settings.lastWorkspace)
    await sessionStore.load(settings.lastWorkspace)
    await approvalManager.init(settings.lastWorkspace)
  }

  createMainWindow()

  initAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
