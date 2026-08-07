import { BrowserWindow, session as electronSession } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nanoid } from 'nanoid'
import { mergePawprintTheme, DEFAULT_PAWPRINT_THEME, type PawprintThemeTokens } from './theme'
import { installPawprintProtocolHandler, setServedContent, clearServedContent, pawprintEntryUrl, buildConnectSrc } from './protocol'
import { bundlePawprint } from './bundler'
import { readManifest, readState, writeStateFromMainProcess } from './storage'
import { readRegistry, writeRegistry, removeInstanceFromRegistry, deleteState } from './storage'
import { readSource } from './storage'
import { PawprintStateWatcher } from './stateWatcher'
import type { PawprintInstanceRecord } from './types'
import { emitPawprintsChanged } from './events'

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

// Resolved once the 'closed' handler has finished its own async cleanup (stateWatcher.stop(),
// persistInstanceRecordClosed()) for a given instanceId — NOT just once the BrowserWindow itself
// has closed. deleteInstance() needs to wait for this, not just win.close(), so its own registry
// removal always runs strictly after persistInstanceRecordClosed()'s write to the same file;
// otherwise the two could race (persistInstanceRecordClosed() reading the registry before
// deleteInstance()'s removal has landed, then re-adding a stale record on its own write).
const pendingCloseCleanup = new Map<string, Array<() => void>>()

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
  emitPawprintsChanged()
}

/** Re-exported so existing callers/tests importing buildConnectSrc from windowManager.ts keep
 *  working — the real definition now lives in protocol.ts so htmlShell() can call it directly
 *  without a circular import (windowManager.ts already imports from protocol.ts). */
export { buildConnectSrc }

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

  // Lowercased: the pawprint:// scheme is registered as a standard/secure privileged scheme
  // (protocol.ts's registerPawprintSchemePrivileges), so it's WHATWG "special scheme" per
  // Chromium's own URL parser — Chromium lowercases the hostname portion of any navigation URL
  // before the protocol.handle() callback ever sees request.url, regardless of the original
  // casing used in win.loadURL()/pawprintEntryUrl(). nanoid()'s default alphabet includes
  // uppercase letters, so a freshly-minted id containing one silently mismatched every
  // case-sensitive lookup keyed by the original mixed-case string (servedByInstance in
  // protocol.ts, liveInstances here, the session partition string, and the on-disk state file
  // path) — the request that actually arrived used the lowercased hostname, missed
  // servedByInstance's mixed-case key, and the handler fell through to its 404 Response, which
  // rendered as literal "Not found" text in the window (no Content-Type set on that response).
  // Reproduced via `new URL('pawprint://AbC.../index.html').hostname` returning the exact same
  // mixed-case string in plain Node (not itself a special scheme there) while Electron/Chromium's
  // real navigation path lowercases it — the mismatch only bit when nanoid happened to produce an
  // uppercase character, which is why one instance could work while a later one silently failed.
  // Force lowercase at the single point instanceId is minted so every downstream consumer (this
  // function, protocol.ts, storage.ts's state path, findInstanceKeyForWebContents) stays
  // consistent by construction — never reintroduce mixed-case ids here.
  const instanceId = opts.instanceId ?? nanoid(10).toLowerCase()
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
  setServedContent(instanceId, { bundleJs: bundle.code, themeJson: JSON.stringify(theme), approvedDomains: manifest.approvedDomains })

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
    persistInstanceRecordClosed(opts.pawprintId, instanceId)
      .catch((err) => {
        console.error(`[Pawprint ${opts.pawprintId}/${instanceId}] failed to persist closed state:`, err)
      })
      .finally(() => {
        const waiters = pendingCloseCleanup.get(instanceId)
        if (!waiters) return
        pendingCloseCleanup.delete(instanceId)
        for (const resolve of waiters) resolve()
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
    emitPawprintsChanged()
  }
}

export function closePawprintWindow(instanceId: string): void {
  const live = liveInstances.get(instanceId)
  if (!live) return
  if (!live.window.isDestroyed()) live.window.close()
}

/** Like closePawprintWindow(), but resolves only once the window's own 'closed' handler has
 *  finished its async cleanup (stateWatcher stop + persistInstanceRecordClosed's registry
 *  write) — not merely once the OS-level window handle is gone. Used by deleteInstance() so its
 *  own registry removal is guaranteed to run strictly after that write, never racing it. A
 *  no-op (resolves immediately) if the instance isn't currently open. */
export function closePawprintWindowAndWaitForCleanup(instanceId: string): Promise<void> {
  const live = liveInstances.get(instanceId)
  if (!live || live.window.isDestroyed()) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const waiters = pendingCloseCleanup.get(instanceId) ?? []
    waiters.push(resolve)
    pendingCloseCleanup.set(instanceId, waiters)
    live.window.close()
  })
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

/**
 * Permanently deletes one instance of a Pawprint: closes its window if open (waiting for that
 * window's own 'closed' cleanup — including persistInstanceRecordClosed()'s registry write — to
 * fully finish first, so the registry removal below can never race it and get clobbered by a
 * stale re-add), then deletes its persisted state file and removes its record from the
 * cross-Pawprint registry. Does NOT touch the Pawprint's manifest/source/packages — those are
 * shared across all instances of a Pawprint and are only removed by deletePawprintById().
 *
 * Deliberately allowed to bring a Pawprint down to zero known instances, for both instance
 * models: the "My Pawprints" panel already renders a synthetic placeholder row (keyed by the
 * Pawprint's own id) whenever a Pawprint has no real instance records, letting the user reopen a
 * fresh one on demand — see PawprintsPanel.tsx's `displayInstances` fallback. There is nothing
 * to "break" by reaching zero instances, so no special-casing "last instance" here is needed.
 */
export async function deleteInstance(pawprintId: string, instanceId: string): Promise<void> {
  await closePawprintWindowAndWaitForCleanup(instanceId)
  await deleteState(pawprintId, instanceId)
  await removeInstanceFromRegistry(pawprintId, instanceId)
  emitPawprintsChanged()
}

export function findInstanceKeyForWebContents(webContentsId: number): { pawprintId: string; instanceId: string } | null {
  for (const live of liveInstances.values()) {
    if (!live.window.isDestroyed() && live.window.webContents.id === webContentsId) {
      return { pawprintId: live.pawprintId, instanceId: live.instanceId }
    }
  }
  return null
}
