import { mock } from 'bun:test'
import { tmpdir } from 'node:os'

/**
 * Shared `node:os` mock for tests that exercise code touching the global Klenny dir (`~/.klenny`)
 * — e.g. `dataDir.ts`'s `globalKlennyDir()`, which calls `homedir()`. Redirects it to a mutable
 * fake home so tests never read/write the real user home directory.
 *
 * Same process-global gotcha as `testElectronMock.ts`: `mock.module('node:os', ...)` only takes
 * effect for consumer modules (like `dataDir.ts`) not yet loaded anywhere in the whole test run —
 * whichever mock factory is registered first wins for every test file, permanently. Multiple test
 * files each declaring their OWN separate `mock.module('node:os', ...)` with their own local
 * `fakeHome` variable is a real, silent bug: whichever file's factory "wins" the race means every
 * OTHER file's `homedir()` calls resolve through that file's closure, not its own — so setting a
 * local `fakeHome` in a losing file's `beforeAll` does nothing, and worse, tests can silently read
 * or write the real `~/.klenny` if no file's mock happened to load before `dataDir.ts` did.
 *
 * Every test file that needs to isolate the home directory MUST import this shared helper (before
 * importing anything that transitively pulls in `node:os` via `dataDir.ts`) so there is only ever
 * one `node:os` mock in play, with one shared mutable `homeMockState` any test can point at its own
 * temp dir for the duration of its own `beforeAll`/`afterAll`.
 */
export const homeMockState = {
  homeDir: ''
}

mock.module('node:os', () => ({
  homedir: () => homeMockState.homeDir,
  tmpdir
}))
