import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatusEvent } from '@shared/types'

const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

let initialized = false
let checkTimer: NodeJS.Timeout | null = null

/** electron-builder's portable target sets this env var; auto-update has no meaning there
 * since there is no installed location to update in place — only the NSIS installer supports it. */
function isPortableBuild(): boolean {
  return process.platform === 'win32' && !!process.env.PORTABLE_EXECUTABLE_DIR
}

/** Whether update checks are meaningful in this build (false for the Windows portable target, or in dev). */
export function isUpdateSupported(): boolean {
  return app.isPackaged && !isPortableBuild()
}

function broadcast(event: UpdateStatusEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app:updateStatus', event)
  }
}

export function initAutoUpdater(): void {
  if (initialized || !app.isPackaged || isPortableBuild()) return
  initialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => broadcast({ status: 'checking' }))
  autoUpdater.on('update-available', (info) => broadcast({ status: 'available', version: info.version }))
  autoUpdater.on('update-not-available', () => broadcast({ status: 'not-available' }))
  autoUpdater.on('download-progress', (p) => broadcast({ status: 'downloading', percent: p.percent }))
  autoUpdater.on('update-downloaded', (info) => broadcast({ status: 'downloaded', version: info.version }))
  autoUpdater.on('error', (err) => broadcast({ status: 'error', message: err?.message ?? String(err) }))

  void checkForUpdates()
  checkTimer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
}

export function stopAutoUpdater(): void {
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = null
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || isPortableBuild()) return
  try {
    await autoUpdater.checkForUpdates()
  } catch {
    // errors are already surfaced via the 'error' event listener above
  }
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}
