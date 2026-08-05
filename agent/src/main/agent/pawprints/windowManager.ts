import { BrowserWindow, session as electronSession } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nanoid } from 'nanoid'
import { mergePawprintTheme, DEFAULT_PAWPRINT_THEME, type PawprintThemeTokens } from './theme'
import { installPawprintProtocolHandler, setServedContent, clearServedContent, pawprintEntryUrl } from './protocol'
import { bundlePawprint } from './bundler'
import { readManifest, readState, writeStateFromMainProcess } from './storage'
import { readRegistry, writeRegistry } from './storage'
import { readSource } from './storage'
import { PawprintStateWatcher } from './stateWatcher'
import type { PawprintInstanceRecord } from './types'

// This app is ESM (`"type": "module"` in package.json), so `__dirname` isn't a global here —
// it must be derived from this module's own `import.meta.url`, same pattern used in ipc.ts.
const __dirname = dirname(fileURLToPath(import.meta.url))

interface LiveInstance {
  pawprintId: string
  instanceId: string
  window: BrowserWindow
  sessionPartition: string
  currentTheme: PawprintThemeTokens
}

const liveInstances = new Map<string, LiveInstance>() // key: instanceId

/** Global cap on simultaneously-open Pawprint windows, across all Pawprint ids combined (plan
 *  section 11, Resource/DoS hardening) — bounds worst-case memory/window-handle usage regardless
 *  of how many Pawprints exist or how many instances any single one has. Chosen generously for
 *  normal desktop use; adjust based on real usage like the package-size/domain-count caps. */
export const MAX_CONCURRENT_PAWPRINT_WINDOWS = 20

const stateWatcher = new PawprintStateWatcher((pawprintId, instanceId, content) => {
  const live = liveInstances.get(instanceId)
  if (!live || live.window.isDestroyed()) return
  live.window.webContents.reload()
  live.window.webContents.send('pawprint:stateChangedExternally', content)
})

function instanceKey(pawprintId: string, instanceId: string): string {
  return `${pawprintId}::${instanceId}`
}

export function getOpenInstanceIds(pawprintId: string): string[] {
  return [...liveInstances.values()].filter((i) => i.pawprintId === pawprintId).map((i) => i.instanceId)
}

export function closeAllInstancesFor(pawprintId: string): void {
  for (const live of [...liveInstances.values()]) {
    if (live.pawprintId === pawprintId) closePawprintWindow(live.instanceId)
  }
}

export function closeAllPawprintWindows(): void {
  for (const instanceId of [...liveInstances.keys()]) closePawprintWindow(instanceId)
}

async function persistInstanceRecord(record: PawprintInstanceRecord): Promise<void> {
  const registry = await readRegistry()
  const idx = registry.instances.findIndex((i) => i.pawprintId === record.pawprintId && i.instanceId === record.instanceId)
  if (idx >= 0) registry.instances[idx] = record
  else registry.instances.push(record)
  await writeRegistry(registry)
}

/** Builds the CSP connect-src value for a given approved-domain list — 'none' when empty, or
 *  the exact https:// hostnames otherwise. Mirrors the webRequest allowlist exactly; webRequest
 *  remains the primary hard gate regardless of what this string says (see protocol.ts / plan's
 *  enforcement-order note). Exported for the Phase 1 proof-of-concept / tests. */
export function buildConnectSrc(approvedDomains: string[]): string {
  if (approvedDomains.length === 0) return "'none'"
  return approvedDomains.map((d) => `https://${d}`).join(' ')
}

function installNetworkAllowlist(sess: Electron.Session, approvedDomains: string[]): void {
  const allowed = new Set(approvedDomains)
  sess.webRequest.onBeforeRequest((details, callback) => {
    try {
      const url = new URL(details.url)
      if (url.protocol === 'pawprint:') return callback({ cancel: false })
      if (url.protocol === 'https:' && allowed.has(url.hostname.toLowerCase())) return callback({ cancel: false })
      callback({ cancel: true })
    } catch {
      callback({ cancel: true })
    }
  })
}

export interface OpenInstanceOptions {
  pawprintId: string
  instanceId?: string
  label?: string
  alwaysOnTop?: boolean
  bounds?: { x: number; y: number; width: number; height: number }
}

/**
 * Opens (or focuses, if already open) one Pawprint instance's BrowserWindow: isolated session
 * per instance, sandbox/contextIsolation/nodeIntegration lockdown, webRequest domain allowlist
 * as the primary network gate, custom-scheme protocol serving the pre-bundled JS + HTML shell,
 * per-instance state-file watcher started for the auto-reload behavior (v4).
 */
export async function openPawprintWindow(opts: OpenInstanceOptions): Promise<{ instanceId: string }> {
  const manifest = await readManifest(opts.pawprintId)
  if (!manifest) throw new Error(`No Pawprint found with id "${opts.pawprintId}"`)

  const instanceId = opts.instanceId ?? nanoid(10)
  const existing = liveInstances.get(instanceId)
  if (existing && !existing.window.isDestroyed()) {
    existing.window.focus()
    return { instanceId }
  }

  if (liveInstances.size >= MAX_CONCURRENT_PAWPRINT_WINDOWS) {
    throw new Error(
      `Cannot open another Pawprint window — the concurrent-window cap (${MAX_CONCURRENT_PAWPRINT_WINDOWS}) has been reached. Close an existing Pawprint window first.`
    )
  }

  const source = await readSource(opts.pawprintId)
  if (source === null) throw new Error(`Pawprint "${opts.pawprintId}" has no source on disk.`)
  const bundle = await bundlePawprint(opts.pawprintId, source, manifest.packages, manifest.sourceVersion)

  const theme = mergePawprintTheme(DEFAULT_PAWPRINT_THEME, manifest.themeOverride)
  setServedContent(instanceId, { bundleJs: bundle.code, themeJson: JSON.stringify(theme) })

  const sessionPartition = `pawprint-${instanceId}`
  const sess = electronSession.fromPartition(sessionPartition, { cache: false })
  installPawprintProtocolHandler(sess)
  installNetworkAllowlist(sess, manifest.approvedDomains)
  sess.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))

  sess.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${buildConnectSrc(manifest.approvedDomains)}`
        ]
      }
    })
  })

  const win = new BrowserWindow({
    width: opts.bounds?.width ?? 420,
    height: opts.bounds?.height ?? 480,
    x: opts.bounds?.x,
    y: opts.bounds?.y,
    alwaysOnTop: opts.alwaysOnTop ?? false,
    title: manifest.name,
    webPreferences: {
      session: sess,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // electron-vite always emits ESM preload output as .mjs when package.json has
      // "type": "module" (electronPreloadVitePlugin hard-codes entryFileNames to
      // '[name].mjs' for format 'es', with no rollupOptions override able to change it —
      // do not "fix" this back to .js, the file will not exist and preload will silently
      // fail with an ENOENT that only surfaces in the sandboxed window's own console).
      // This file (windowManager.ts) is bundled into out/main/, but the preload output
      // lands in the SIBLING out/preload/ directory — matches the main app's own preload
      // reference in ipc.ts (join(__dirname, '../preload/index.cjs')). __dirname alone
      // (no '../preload/' segment) resolves to out/main/ and is always wrong here.
      //
      // Extension is .cjs, not .mjs: per Electron's own docs, sandboxed preload scripts
      // (this window uses sandbox: true, a hard security requirement) cannot use ESM at
      // all — they run as plain JavaScript with no ESM context, require('electron') only.
      // electron.vite.config.ts forces format: 'cjs' + entryFileNames: '[name].cjs' for
      // BOTH preload entries for this reason (electron-vite's preload build rejects
      // having two different output formats for its two entries in one config).
      preload: join(__dirname, '../preload/preloadPawprint.cjs')
    }
  })

  liveInstances.set(instanceId, { pawprintId: opts.pawprintId, instanceId, window: win, sessionPartition, currentTheme: theme })

  // Forward the sandboxed renderer's own console output/crashes/load failures to the main
  // process's console. Without this, a JS error thrown inside the Pawprint's renderer (e.g. a
  // runtime exception in the bundled React app) is only visible in that window's own DevTools —
  // invisible here and in the terminal, making a blank-window bug look silent/unexplained even
  // though the renderer did actually report something. Mirrors the equivalent handlers already
  // wired for the main app's own window in ipc.ts (preload-error/render-process-gone/did-fail-load).
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[Pawprint ${opts.pawprintId}/${instanceId}] console:`, message, `(${sourceId}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[Pawprint ${opts.pawprintId}/${instanceId}] renderer process gone:`, details)
  })
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[Pawprint ${opts.pawprintId}/${instanceId}] failed to load:`, code, desc)
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[Pawprint ${opts.pawprintId}/${instanceId}] preload failed:`, preloadPath, error)
  })

  await win.loadURL(pawprintEntryUrl(instanceId))

  const initialState = await readState(opts.pawprintId, instanceId)
  stateWatcher.start(opts.pawprintId, instanceId, initialState !== null ? JSON.stringify(initialState, null, 2) : null)

  // Electron fires 'resize'/'move' continuously (many times per second) for the whole
  // duration of an actual drag, not once at the end. Debounced so a drag produces one
  // registry write ~200ms after motion settles, not dozens of overlapping writes to the
  // same destination file. Each call is also explicitly `.catch()`'d (rather than left as
  // an unawaited `void` rejection) so a real, non-transient write failure is logged instead
  // of surfacing as an UnhandledPromiseRejectionWarning in the terminal.
  let persistBoundsTimer: NodeJS.Timeout | null = null
  const persistBounds = () => {
    if (persistBoundsTimer) clearTimeout(persistBoundsTimer)
    persistBoundsTimer = setTimeout(() => {
      persistBoundsTimer = null
      if (win.isDestroyed()) return
      const b = win.getBounds()
      persistInstanceRecord({
        pawprintId: opts.pawprintId,
        instanceId,
        label: opts.label,
        bounds: b,
        alwaysOnTop: win.isAlwaysOnTop(),
        openOnLaunch: true,
        updatedAt: Date.now()
      }).catch((err) => {
        console.error(`[Pawprint ${opts.pawprintId}/${instanceId}] failed to persist window bounds:`, err)
      })
    }, 200)
  }
  win.on('resize', persistBounds)
  win.on('move', persistBounds)
  win.on('closed', () => {
    if (persistBoundsTimer) clearTimeout(persistBoundsTimer)
    liveInstances.delete(instanceId)
    clearServedContent(instanceId)
    stateWatcher.stop(opts.pawprintId, instanceId)
    persistInstanceRecordClosed(opts.pawprintId, instanceId).catch((err) => {
      console.error(`[Pawprint ${opts.pawprintId}/${instanceId}] failed to persist closed state:`, err)
    })
  })

  await persistInstanceRecord({
    pawprintId: opts.pawprintId,
    instanceId,
    label: opts.label,
    bounds: win.getBounds(),
    alwaysOnTop: win.isAlwaysOnTop(),
    openOnLaunch: true,
    updatedAt: Date.now()
  })

  return { instanceId }
}

async function persistInstanceRecordClosed(pawprintId: string, instanceId: string): Promise<void> {
  const registry = await readRegistry()
  const idx = registry.instances.findIndex((i) => i.pawprintId === pawprintId && i.instanceId === instanceId)
  if (idx >= 0) {
    registry.instances[idx] = { ...registry.instances[idx], openOnLaunch: false, updatedAt: Date.now() }
    await writeRegistry(registry)
  }
}

export function closePawprintWindow(instanceId: string): void {
  const live = liveInstances.get(instanceId)
  if (!live) return
  if (!live.window.isDestroyed()) live.window.close()
}

export function setAlwaysOnTop(instanceId: string, value: boolean): void {
  const live = liveInstances.get(instanceId)
  if (!live || live.window.isDestroyed()) return
  live.window.setAlwaysOnTop(value)
}

/** Called from the setState IPC handler (see ipc.ts wiring) — writes the instance's state file
 *  and records the resulting content hash with the watcher so the write doesn't self-trigger a
 *  reload. */
export async function handleSetState(pawprintId: string, instanceId: string, data: unknown): Promise<void> {
  const json = await writeStateFromMainProcess(pawprintId, instanceId, data)
  stateWatcher.recordSelfWrite(pawprintId, instanceId, json)
}

export async function handleGetState(pawprintId: string, instanceId: string): Promise<unknown> {
  return readState(pawprintId, instanceId)
}

export function getInstanceTheme(instanceId: string): PawprintThemeTokens | null {
  return liveInstances.get(instanceId)?.currentTheme ?? null
}

/** Live-broadcasts a merged theme to every currently-open instance of a Pawprint (plan section 6
 *  "live broadcast via onThemeChange") — called after a theme-override IPC write. Does not
 *  reload the window; the Pawprint's own onThemeChange subscriber (via the preload bridge) is
 *  expected to re-render in place. */
export function broadcastThemeOverride(pawprintId: string, theme: PawprintThemeTokens): void {
  for (const live of liveInstances.values()) {
    if (live.pawprintId !== pawprintId || live.window.isDestroyed()) continue
    live.currentTheme = theme
    live.window.webContents.send('pawprint:themeChanged', theme)
  }
}

/** Re-opens every instance flagged openOnLaunch:true in the registry — called once at app
 *  startup. Failures for one instance are logged and skipped rather than blocking the rest
 *  (per plan's "skip-with-toast on any single instance failure" — the toast itself is a
 *  renderer-side concern wired through emitToAll from the caller in ipc.ts, not here). */
export async function reopenAllOnLaunch(onError?: (pawprintId: string, instanceId: string, error: unknown) => void): Promise<void> {
  const registry = await readRegistry()
  for (const record of registry.instances.filter((i) => i.openOnLaunch)) {
    try {
      await openPawprintWindow({
        pawprintId: record.pawprintId,
        instanceId: record.instanceId,
        label: record.label,
        alwaysOnTop: record.alwaysOnTop,
        bounds: record.bounds
      })
    } catch (e) {
      console.error('Pawprints: failed to reopen instance on launch', record.pawprintId, record.instanceId, e)
      onError?.(record.pawprintId, record.instanceId, e)
    }
  }
}

export function findInstanceKeyForWebContents(webContentsId: number): { pawprintId: string; instanceId: string } | null {
  for (const live of liveInstances.values()) {
    if (!live.window.isDestroyed() && live.window.webContents.id === webContentsId) {
      return { pawprintId: live.pawprintId, instanceId: live.instanceId }
    }
  }
  return null
}
