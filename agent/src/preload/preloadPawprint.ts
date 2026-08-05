import { contextBridge, ipcRenderer } from 'electron'

/**
 * Dedicated preload script for a Pawprint's sandboxed BrowserWindow — deliberately separate
 * from src/preload/index.ts (the main app's preload), which exposes a much broader API
 * (file tools, settings, IPC for the whole app) that a Pawprint must never reach.
 *
 * This bridge is the ENTIRE surface a Pawprint's renderer can use to talk to the host process.
 * No Node integration, no other IPC channels, no access to the main app's KlennyApi. The
 * Pawprint SDK virtual module (see pawprints/sdk.ts) calls these five methods via
 * `window.__pawprintBridge` and nothing else.
 *
 * The instance id is embedded in the loaded pawprint:// URL itself (see pawprints/protocol.ts's
 * pawprintEntryUrl()), so the main process's IPC handlers resolve which instance a given call
 * belongs to via the sender's webContents id — the renderer never needs to (and cannot) pass
 * an arbitrary instanceId itself.
 *
 * These channel names are INTENTIONALLY duplicated as literals here rather than imported from
 * '@shared/ipc' (see the IPC.pawprintRenderer* constants there, which must be kept in sync with
 * these literals by hand). This is load-bearing, not a style choice: Electron's sandboxed
 * preload loader runs a restricted `require` that can only load electron itself — it cannot
 * resolve relative chunk files. Since src/preload/index.ts also imports '@shared/ipc', Rollup
 * factors that shared import into a separate chunk file whenever both preload entries import
 * it, and that chunk `require()` call then fails at runtime with "module not found" inside the
 * sandboxed window (this exact failure was hit and diagnosed before this comment was written —
 * do not reintroduce the shared import without re-solving the chunking problem some other way).
 */
const PAWPRINT_IPC = {
  getState: 'pawprint:getState',
  setState: 'pawprint:setState',
  getTheme: 'pawprint:getTheme',
  closeSelf: 'pawprint:closeSelf',
  requestNewInstance: 'pawprint:requestNewInstance',
  themeChanged: 'pawprint:themeChanged'
} as const

contextBridge.exposeInMainWorld('__pawprintBridge', {
  getState: () => ipcRenderer.invoke(PAWPRINT_IPC.getState),
  setState: (next: unknown) => ipcRenderer.invoke(PAWPRINT_IPC.setState, next),
  getTheme: () => ipcRenderer.invoke(PAWPRINT_IPC.getTheme),
  onThemeChange: (cb: (theme: unknown) => void) => {
    const listener = (_event: unknown, theme: unknown) => cb(theme)
    ipcRenderer.on(PAWPRINT_IPC.themeChanged, listener)
    return () => ipcRenderer.removeListener(PAWPRINT_IPC.themeChanged, listener)
  },
  close: () => ipcRenderer.invoke(PAWPRINT_IPC.closeSelf),
  requestNewInstance: (label?: string) => ipcRenderer.invoke(PAWPRINT_IPC.requestNewInstance, label)
})
