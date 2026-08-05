import { mock } from 'bun:test'

/**
 * Shared `electron` module mock for tests that exercise main-process code (ApprovalManager,
 * projectsRegistry, the cross-project tools, etc).
 *
 * IMPORTANT: `mock.module('electron', ...)` is process-global in Bun — whichever mock is
 * active the *first time* any given consumer module (e.g. `workspace.ts`, which does
 * `import { dialog } from 'electron'`) is loaded anywhere in the whole test run is the one
 * that module's binding sticks with, even if a later test file calls `mock.module('electron',
 * ...)` again with a different factory. Every test file that needs to mock electron MUST
 * import this shared helper (before importing anything that transitively pulls in electron)
 * so there is only ever one mock shape in play, with a mutable `state` the individual tests
 * can adjust per-run without re-registering the module.
 */
export const electronMockState = {
  userDataDir: '',
  isPackaged: false
}

// Minimal fake NativeImage: real dimensions don't matter for the tests that touch this (they
// only check isEmpty()/path plumbing, not actual pixel data), so every image reports the same
// square size — that also keeps centerCropToSquare() a no-op in tests, which is fine since its
// cropping logic is covered directly against this same fake in branding.test.ts.
function makeFakeImage(empty: boolean) {
  const img = {
    isEmpty: () => empty,
    getSize: () => ({ width: 256, height: 256 }),
    resize: (_opts: { width: number; height: number }) => img,
    crop: (_rect: { x: number; y: number; width: number; height: number }) => img
  }
  return img
}

let nextFakeWebContentsId = 1

/** Builds a fake BrowserWindow class supporting both the static getAllWindows()/
 *  getFocusedWindow() surface most orchestrator tests need (kept as no-op-returning-empty, same
 *  as before) and a real constructible instance for pawprints/windowManager.ts tests — enough
 *  behaviorally-real state (destroyed flag, bounds, alwaysOnTop, a tiny event-listener map, a
 *  fake webContents with a unique id) to exercise real open/close/focus/reload/setAlwaysOnTop
 *  logic without an actual OS window ever being created. */
function makeFakeBrowserWindowClass() {
  class FakeBrowserWindow {
    static getAllWindows(): FakeBrowserWindow[] {
      return []
    }
    static getFocusedWindow(): FakeBrowserWindow | null {
      return null
    }

    private destroyed = false
    private alwaysOnTop: boolean
    private bounds: { x: number; y: number; width: number; height: number }
    private listeners = new Map<string, Set<() => void>>()
    webContents: {
      id: number
      reload: () => void
      send: (_channel: string, ..._args: unknown[]) => void
      on: (_event: string, _listener: (...args: unknown[]) => void) => void
    }

    constructor(opts: {
      width?: number
      height?: number
      x?: number
      y?: number
      alwaysOnTop?: boolean
      [key: string]: unknown
    }) {
      this.alwaysOnTop = opts.alwaysOnTop ?? false
      this.bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width ?? 420, height: opts.height ?? 480 }
      const id = nextFakeWebContentsId++
      // Real Electron's webContents emits console-message/render-process-gone/did-fail-load/
      // preload-error, among others — windowManager.ts subscribes to these for renderer-side
      // error/log forwarding (see its openPawprintWindow). Tests never need those events to
      // actually fire, just for `.on()` to exist and not throw when called.
      this.webContents = { id, reload: () => {}, send: () => {}, on: () => {} }
    }

    isDestroyed(): boolean {
      return this.destroyed
    }
    focus(): void {}
    close(): void {
      if (this.destroyed) return
      this.destroyed = true
      for (const cb of this.listeners.get('closed') ?? []) cb()
    }
    isAlwaysOnTop(): boolean {
      return this.alwaysOnTop
    }
    setAlwaysOnTop(v: boolean): void {
      this.alwaysOnTop = v
    }
    getBounds() {
      return this.bounds
    }
    on(event: string, cb: () => void): void {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set())
      this.listeners.get(event)!.add(cb)
    }
    async loadURL(_url: string): Promise<void> {}
  }
  return FakeBrowserWindow
}

mock.module('electron', () => ({
  app: {
    getPath: () => electronMockState.userDataDir,
    isPackaged: electronMockState.isPackaged
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  shell: {
    openExternal: async () => {}
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8')
  },
  nativeImage: {
    createFromPath: (path: string) => makeFakeImage(!path)
  },
  // Constructible fake BrowserWindow, with the static getAllWindows()/getFocusedWindow() methods
  // most orchestrator tests rely on staying empty/null (no windows ever exist in the test runner
  // for that code path — it never actually sends a real desktop Notification). Pawprints tests
  // that DO construct a real instance (pawprints-windowmanager.test.ts) get a minimal but
  // behaviorally real fake: isDestroyed()/focus()/close()/setAlwaysOnTop()/getBounds()/on() all
  // work against real internal state, webContents exposes a fake id/reload()/send(), and
  // loadURL()/whenReady semantics are no-ops (no real content is ever fetched in tests).
  BrowserWindow: makeFakeBrowserWindowClass(),
  Notification: class {
    constructor(_opts: { title: string; body: string }) {}
    show() {}
  },
  // Minimal fakes so pawprints/protocol.ts (`import { protocol } from 'electron'`) and
  // pawprints/windowManager.ts (`import { session } from 'electron'`) can load without throwing
  // in the test runner — no test currently exercises real scheme registration or per-session
  // request interception, so these are no-ops rather than behaviorally faithful fakes.
  protocol: {
    registerSchemesAsPrivileged: (_schemes: unknown[]) => {}
  },
  session: {
    // Real Electron's `session.fromPartition()` returns the SAME cached Session object for a
    // repeated partition string — this caching is exactly what caused the real "Failed to
    // register protocol: pawprint" bug (protocol.ts's installPawprintProtocolHandler being
    // called a 2nd time on an already-`handle()`-d session, when windowManager.ts reopens a
    // previously-closed instance whose `instanceId` — and therefore whose `pawprint-<id>`
    // partition — is reused). Must mirror that caching (and `protocol.handle()` throwing on a
    // scheme that's already handled, matching real Electron) or this class of bug is invisible
    // to tests.
    fromPartition: ((): ((partition: string) => unknown) => {
      const cache = new Map<string, unknown>()
      return (partition: string) => {
        const existing = cache.get(partition)
        if (existing) return existing
        const handledSchemes = new Set<string>()
        // Handlers ARE stored (not discarded) so pawprints-protocol.test.ts can invoke a
        // registered scheme handler directly and assert on its real Response — needed to catch
        // bugs like the htmlShell() hardcoded connect-src 'none' regression, which no purely
        // behavioral (never-invokes-the-handler) mock could ever surface.
        const schemeHandlers = new Map<string, (request: Request) => Response | Promise<Response>>()
        const sess = {
          protocol: {
            handle: (scheme: string, handler: (request: Request) => Response | Promise<Response>) => {
              if (handledSchemes.has(scheme)) {
                throw new Error(`Failed to register protocol: ${scheme}`)
              }
              handledSchemes.add(scheme)
              schemeHandlers.set(scheme, handler)
            },
            isProtocolHandled: (scheme: string) => handledSchemes.has(scheme),
            unhandle: (scheme: string) => {
              handledSchemes.delete(scheme)
              schemeHandlers.delete(scheme)
            },
            // Test-only helper (not part of the real Electron protocol API) so tests can invoke
            // a registered scheme's handler directly without a real network stack.
            __getHandler: (scheme: string) => schemeHandlers.get(scheme)
          },
          webRequest: { onBeforeRequest: (_handler: unknown) => {}, onHeadersReceived: (_handler: unknown) => {} },
          setPermissionRequestHandler: (_handler: unknown) => {}
        }
        cache.set(partition, sess)
        return sess
      }
    })(),
    defaultSession: {
      protocol: {
        handle: (_scheme: string, _handler: unknown) => {},
        isProtocolHandled: (_scheme: string) => false,
        unhandle: (_scheme: string) => {}
      },
      webRequest: { onBeforeRequest: (_handler: unknown) => {}, onHeadersReceived: (_handler: unknown) => {} },
      setPermissionRequestHandler: (_handler: unknown) => {}
    }
  }
}))
