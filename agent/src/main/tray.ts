/**
 * System tray + minimize-to-tray + auto-start-with-OS support (Phase 4 of the Personal
 * Assistant Platform plan). Lets the scheduler and Discord gateway keep running when the main
 * window is closed, without fully quitting the app.
 */
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'
import { loadSettings } from './settings'

let tray: Tray | null = null
/** True once the user has explicitly chosen Quit from the tray menu — lets the window's
 *  'close' handler distinguish "minimize to tray" from "actually quit". */
let isQuitting = false

export function isAppQuitting(): boolean {
  return isQuitting
}

function iconPath(): string {
  return join(__dirname, '../../build/icons/icon.png')
}

export function createTray(getMainWindow: () => BrowserWindow | null): void {
  if (tray) return
  const image = nativeImage.createFromPath(iconPath())
  tray = new Tray(image.isEmpty() ? image : image.resize({ width: 16, height: 16 }))
  tray.setToolTip('Klenny Code')

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Klenny Code',
      click: () => {
        const win = getMainWindow()
        if (win) {
          win.show()
          win.focus()
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => {
    const win = getMainWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/** Cached synchronously-readable mirror of settings.minimizeToTray — Electron's 'close' event
 *  handler must call preventDefault() synchronously, so it can't await loadSettings() itself.
 *  Kept in sync via refreshMinimizeToTrayCache(), called at startup and whenever the setting
 *  changes (see settings:set IPC handler in ipc.ts). */
let minimizeToTrayCached = false

export async function refreshMinimizeToTrayCache(): Promise<void> {
  const settings = await loadSettings()
  minimizeToTrayCached = settings.minimizeToTray
}

/** Wires a window's 'close' event to minimize-to-tray instead of quitting, when
 *  settings.minimizeToTray is enabled (checked via the synchronous cache above). */
export function wireMinimizeToTray(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (isQuitting || !minimizeToTrayCached) return
    e.preventDefault()
    win.hide()
  })
}

export async function applyAutoStartSetting(startOnLogin: boolean): Promise<void> {
  if (process.platform === 'linux') return // setLoginItemSettings is unreliable on many Linux DEs; skip rather than silently fail
  app.setLoginItemSettings({ openAtLogin: startOnLogin })
}
