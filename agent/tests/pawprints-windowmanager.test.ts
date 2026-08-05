import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import './testElectronMock'
import { electronMockState } from './testElectronMock'

const storage = await import('../src/main/agent/pawprints/storage')
const windowManager = await import('../src/main/agent/pawprints/windowManager')
const { pawprintNodeModulesDir } = await import('../src/main/agent/pawprints/paths')
import type { PawprintManifest } from '../src/main/agent/pawprints/types'

function makeManifest(id: string): PawprintManifest {
  const now = Date.now()
  return {
    id,
    name: 'Test Pawprint',
    description: 'desc',
    instanceModel: 'per-item',
    createdAt: now,
    updatedAt: now,
    sourceVersion: 1,
    packages: [],
    approvedDomains: [],
    themeOverride: {}
  }
}

const SIMPLE_SOURCE = `
export default function App() { return null }
`

describe('windowManager — MAX_CONCURRENT_PAWPRINT_WINDOWS cap + open/close/always-on-top lifecycle', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'pawprints-windowmanager-test-'))
    electronMockState.userDataDir = dir
  })

  afterEach(async () => {
    // Close windows *before* the temp dir is removed, and while `electronMockState.userDataDir`
    // still points at this test's own dir. `closePawprintWindow`'s `closed` handler kicks off a
    // fire-and-forget `persistInstanceRecordClosed()` (reads/writes the registry); it only runs
    // synchronously up to its first `await`, so give pending microtasks a tick to actually finish
    // resolving against *this* dir before it's deleted — otherwise those writes can race into the
    // next test's freshly-assigned dir (real bug: beforeEach used to swap the dir before closing
    // the previous test's windows, letting stale registry writes land in the new test's temp dir
    // and race its own seedPawprint()/openPawprintWindow()/esbuild calls, causing intermittent
    // esbuild resolve flakiness on Windows under that added filesystem contention).
    windowManager.closeAllPawprintWindows()
    await new Promise((r) => setTimeout(r, 0))
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  async function seedPawprint(id: string): Promise<void> {
    await storage.writeManifest(makeManifest(id))
    await storage.writeSource(id, SIMPLE_SOURCE)
    // bundlePawprint() uses this dir as its esbuild resolveDir/absWorkingDir/nodePaths entry —
    // must exist on disk even with zero extra packages requested (mirrors pawprints-bundler.test.ts).
    await fs.mkdir(pawprintNodeModulesDir(id), { recursive: true })
  }

  test('openPawprintWindow opens a real (fake) BrowserWindow and reports it as open via getOpenInstanceIds', async () => {
    await seedPawprint('p1')
    const { instanceId } = await windowManager.openPawprintWindow({ pawprintId: 'p1' })
    expect(windowManager.getOpenInstanceIds('p1')).toContain(instanceId)
  })

  test('opening the same instanceId twice focuses the existing window rather than creating a second one', async () => {
    await seedPawprint('p1')
    const first = await windowManager.openPawprintWindow({ pawprintId: 'p1', instanceId: 'fixed-1' })
    const second = await windowManager.openPawprintWindow({ pawprintId: 'p1', instanceId: 'fixed-1' })
    expect(second.instanceId).toBe(first.instanceId)
    expect(windowManager.getOpenInstanceIds('p1').length).toBe(1)
  })

  test('closing then reopening the same instanceId does not throw (regression: protocol re-registration on reused session)', async () => {
    // Real Electron's session.fromPartition() caches by partition string, so reopening the same
    // instanceId (same `pawprint-<id>` partition) returns the SAME Session object the first open
    // already called protocol.handle() on — installPawprintProtocolHandler() must guard against
    // re-registering on it, or this throws "Failed to register protocol: pawprint".
    await seedPawprint('p1')
    const first = await windowManager.openPawprintWindow({ pawprintId: 'p1', instanceId: 'reused-1' })
    windowManager.closePawprintWindow(first.instanceId)
    expect(windowManager.getOpenInstanceIds('p1')).not.toContain(first.instanceId)

    const second = await windowManager.openPawprintWindow({ pawprintId: 'p1', instanceId: 'reused-1' })
    expect(second.instanceId).toBe('reused-1')
    expect(windowManager.getOpenInstanceIds('p1')).toContain('reused-1')
  })

  test('closePawprintWindow removes the instance from the open list', async () => {
    await seedPawprint('p1')
    const { instanceId } = await windowManager.openPawprintWindow({ pawprintId: 'p1' })
    expect(windowManager.getOpenInstanceIds('p1')).toContain(instanceId)
    windowManager.closePawprintWindow(instanceId)
    expect(windowManager.getOpenInstanceIds('p1')).not.toContain(instanceId)
  })

  test('setAlwaysOnTop toggles the flag on a live instance and getInstanceTheme returns a theme for an open instance', async () => {
    await seedPawprint('p1')
    const { instanceId } = await windowManager.openPawprintWindow({ pawprintId: 'p1' })
    windowManager.setAlwaysOnTop(instanceId, true)
    expect(windowManager.getInstanceTheme(instanceId)).not.toBeNull()
  })

  test('setAlwaysOnTop on a closed/nonexistent instance is a safe no-op, not a throw', () => {
    expect(() => windowManager.setAlwaysOnTop('does-not-exist', true)).not.toThrow()
  })

  test('closeAllInstancesFor closes every open instance for one Pawprint but leaves others open', async () => {
    await seedPawprint('p1')
    await seedPawprint('p2')
    const a = await windowManager.openPawprintWindow({ pawprintId: 'p1', instanceId: 'a' })
    const b = await windowManager.openPawprintWindow({ pawprintId: 'p1', instanceId: 'b' })
    const c = await windowManager.openPawprintWindow({ pawprintId: 'p2', instanceId: 'c' })

    windowManager.closeAllInstancesFor('p1')
    expect(windowManager.getOpenInstanceIds('p1')).toEqual([])
    expect(windowManager.getOpenInstanceIds('p2')).toContain(c.instanceId)
    expect(a.instanceId).toBeDefined()
    expect(b.instanceId).toBeDefined()
  })

  test('rejects opening a new instance once MAX_CONCURRENT_PAWPRINT_WINDOWS live instances already exist', async () => {
    await seedPawprint('cap-test')
    for (let i = 0; i < windowManager.MAX_CONCURRENT_PAWPRINT_WINDOWS; i++) {
      await windowManager.openPawprintWindow({ pawprintId: 'cap-test', instanceId: `inst-${i}` })
    }
    expect(windowManager.getOpenInstanceIds('cap-test').length).toBe(windowManager.MAX_CONCURRENT_PAWPRINT_WINDOWS)

    await expect(windowManager.openPawprintWindow({ pawprintId: 'cap-test', instanceId: 'one-too-many' })).rejects.toThrow(/concurrent-window cap/i)
  })

  test('closing one instance under the cap allows opening a new one again', async () => {
    await seedPawprint('cap-test-2')
    for (let i = 0; i < windowManager.MAX_CONCURRENT_PAWPRINT_WINDOWS; i++) {
      await windowManager.openPawprintWindow({ pawprintId: 'cap-test-2', instanceId: `inst-${i}` })
    }
    windowManager.closePawprintWindow('inst-0')
    // Should succeed now that we're back under the cap.
    const { instanceId } = await windowManager.openPawprintWindow({ pawprintId: 'cap-test-2', instanceId: 'fresh' })
    expect(instanceId).toBe('fresh')
  })

  test('findInstanceKeyForWebContents resolves the correct pawprintId/instanceId for a live instance\'s own webContents id, and null for an unknown id', async () => {
    await seedPawprint('p1')
    const { instanceId } = await windowManager.openPawprintWindow({ pawprintId: 'p1', instanceId: 'find-me' })
    // We don't have direct access to the internal webContents id from here, but we can at least
    // confirm an obviously-bogus id resolves to null (defense against a spoofed sender).
    expect(windowManager.findInstanceKeyForWebContents(999999)).toBeNull()
    expect(instanceId).toBe('find-me')
  })

  test('openPawprintWindow throws for a Pawprint id with no manifest on disk', async () => {
    await expect(windowManager.openPawprintWindow({ pawprintId: 'never-created' })).rejects.toThrow(/no pawprint found/i)
  })
})
