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

mock.module('electron', () => ({
  app: {
    getPath: () => electronMockState.userDataDir,
    isPackaged: electronMockState.isPackaged
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))
