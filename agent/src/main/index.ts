import { app } from 'electron'
import { existsSync } from 'node:fs'
import { createMainWindow, getMainWindow, registerIpcHandlers, refreshIndexingForWorkspace } from './ipc'
import { initAutoUpdater } from './updater'
import { loadSettings } from './settings'
import { setWorkspace } from './workspace'
import { sessionStore } from './session/store'
import { approvalManager } from './agent/approval/manager'
import { stopIndexing } from './agent/codeindex/manager'
import { disposeAllTerminals } from './terminal'
import { disposeAllSessions as disposeAllBrowserSessions } from './browser/manager'
import { createTray, refreshMinimizeToTrayCache, applyAutoStartSetting, markAppQuitting } from './tray'
import { scheduledTaskManager } from './scheduler/manager'
import { runScheduledTask } from './agent/orchestrator'
import { startDiscordClient, stopDiscordClient, setInboundCommandHandler } from './integrations/discord'
import { runInboundDiscordCommand } from './agent/discordBridge'
import { registerPawprintSchemePrivileges } from './agent/pawprints/protocol'
import { reopenAllOnLaunch as reopenAllPawprintsOnLaunch, closeAllPawprintWindows } from './agent/pawprints/manager'
import { installProcessLogTee, appendProcessLogMarker } from './processLog'
import { applyLoginShellPath } from './loginShellPath'

// FIRST statement in the main process: everything logged before this point is not captured, and
// the app's own `[cache]`/diagnostic output is the only evidence for whole classes of bug (see
// processLog.ts). Module-level side effects in the imports above still precede it — acceptable,
// since they don't log.
installProcessLogTee()
appendProcessLogMarker(`App session started (v${app.getVersion()}, pid ${process.pid}) — ${new Date().toLocaleString()}`)

// Must run before app.whenReady() per Electron's custom-scheme privilege requirement.
registerPawprintSchemePrivileges()

// macOS/Linux GUI launches inherit a bare PATH; start reading the user's login-shell PATH now so
// it overlaps with Electron's own startup (no-op on Windows; see loginShellPath.ts).
const loginShellPathReady = applyLoginShellPath()

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.dantahir.klenny')
  }
  // Before anything can spawn a process (IPC handlers, terminal, scheduler, run_command) or cache
  // PATH-derived results (shells.ts detectShells). Bounded by the probe's own timeout.
  await loginShellPathReady
  registerIpcHandlers()

  const settings = await loadSettings()
  // Must happen before any tab gets created (loadAssistantTabs/load below can both create a
  // fresh empty tab) so new tabs start on the user's configured default model instead of the
  // hardcoded DEFAULT_MAIN_MODEL fallback.
  sessionStore.setDefaultModel(settings.mainModel)
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
  // getMainWindow(), not getAllWindows()[0] — an open Pawprint window can be first in that list.
  void createTray(() => getMainWindow())

  // Personal Assistant Platform (Phase 4): scheduler + Discord gateway run for the lifetime of
  // the app/tray process, independent of any specific chat tab.
  scheduledTaskManager.setRunner(runScheduledTask)
  await scheduledTaskManager.load()
  scheduledTaskManager.startTicking()
  setInboundCommandHandler(runInboundDiscordCommand)
  void startDiscordClient()

  initAutoUpdater()

  // Restore any Pawprint windows flagged openOnLaunch:true — failures for one instance are
  // logged and skipped rather than blocking the rest (see reopenAllOnLaunch's doc comment).
  void reopenAllPawprintsOnLaunch()

  // macOS Dock-icon click. With minimizeToTray on, the red close button only *hides* the main
  // window, so "no windows exist" is the wrong test — re-show the hidden one instead.
  app.on('activate', () => {
    const main = getMainWindow()
    if (!main) {
      createMainWindow()
      return
    }
    main.show()
    main.focus()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Must be first: windows get 'close' right after this, and the minimize-to-tray handler would
  // otherwise cancel the close and abort the quit (see tray.ts isQuitting).
  markAppQuitting()
  void stopIndexing()
  disposeAllTerminals()
  void disposeAllBrowserSessions()
  scheduledTaskManager.stopTicking()
  void stopDiscordClient()
  closeAllPawprintWindows()
})
