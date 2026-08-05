import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import './testElectronMock'
import { electronMockState } from './testElectronMock'

const { PawprintStateWatcher } = await import('../src/main/agent/pawprints/stateWatcher')
const { pawprintStateDir, pawprintStatePath } = await import('../src/main/agent/pawprints/paths')

let tmpUserData: string

beforeEach(async () => {
  tmpUserData = await fs.mkdtemp(join(tmpdir(), 'klenny-test-userdata-'))
  electronMockState.userDataDir = tmpUserData
})

afterEach(async () => {
  await fs.rm(tmpUserData, { recursive: true, force: true }).catch(() => {})
})

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const PAWPRINT_ID = 'sticky-notes'
const INSTANCE_ID = 'abc123'

async function writeStateFileDirect(content: string): Promise<void> {
  const dir = pawprintStateDir(PAWPRINT_ID)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(pawprintStatePath(PAWPRINT_ID, INSTANCE_ID), content, 'utf8')
}

describe('PawprintStateWatcher', () => {
  test('an external write to the state file triggers exactly one debounced change callback', async () => {
    await writeStateFileDirect(JSON.stringify({ v: 0 }))
    const calls: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, content) => calls.push(content))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 }))

    await writeStateFileDirect(JSON.stringify({ v: 1 }))
    await sleep(700) // debounce (400ms) + margin

    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({ v: 1 })
    watcher.stop(PAWPRINT_ID, INSTANCE_ID)
  })

  test('a setState-IPC self-write (recordSelfWrite) does not trigger a spurious change callback', async () => {
    await writeStateFileDirect(JSON.stringify({ v: 0 }))
    const calls: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, content) => calls.push(content))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 }))

    const newJson = JSON.stringify({ v: 1 }, null, 2)
    watcher.recordSelfWrite(PAWPRINT_ID, INSTANCE_ID, newJson)
    await writeStateFileDirect(newJson) // simulates the main process's own writeStateFromMainProcess
    await sleep(700)

    expect(calls.length).toBe(0)
    watcher.stop(PAWPRINT_ID, INSTANCE_ID)
  })

  test('multiple rapid successive external edits within the debounce window collapse into one callback', async () => {
    await writeStateFileDirect(JSON.stringify({ v: 0 }))
    const calls: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, content) => calls.push(content))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 }))

    await writeStateFileDirect(JSON.stringify({ v: 1 }))
    await sleep(100)
    await writeStateFileDirect(JSON.stringify({ v: 2 }))
    await sleep(100)
    await writeStateFileDirect(JSON.stringify({ v: 3 }))
    await sleep(700)

    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual({ v: 3 })
    watcher.stop(PAWPRINT_ID, INSTANCE_ID)
  })

  test('malformed/partial JSON (simulating a read racing a non-atomic write) is tolerated without crashing', async () => {
    await writeStateFileDirect(JSON.stringify({ v: 0 }))
    const calls: unknown[] = []
    const errors: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, content) => calls.push(content))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 }))

    // Write invalid/partial JSON, matching what a non-atomic write-in-progress would look like.
    await writeStateFileDirect('{"v": 1, "incomplete":')
    await sleep(700) // debounce + one retry delay (150ms) + margin

    // No crash, and no callback fired since the content never became valid within the retry.
    expect(calls.length).toBe(0)
    expect(errors.length).toBe(0)
    watcher.stop(PAWPRINT_ID, INSTANCE_ID)
  })

  test('a deleted state file during an open instance results in a graceful skip, not a callback or crash', async () => {
    await writeStateFileDirect(JSON.stringify({ v: 0 }))
    const calls: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, content) => calls.push(content))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 }))

    await fs.rm(pawprintStatePath(PAWPRINT_ID, INSTANCE_ID), { force: true })
    await sleep(700)

    expect(calls.length).toBe(0)
    watcher.stop(PAWPRINT_ID, INSTANCE_ID)
  })

  test('a no-op write with unchanged content does not trigger a callback', async () => {
    const content = JSON.stringify({ v: 0 })
    await writeStateFileDirect(content)
    const calls: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, c) => calls.push(c))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, content)

    await writeStateFileDirect(content) // identical content — a touch, not a real change
    await sleep(700)

    expect(calls.length).toBe(0)
    watcher.stop(PAWPRINT_ID, INSTANCE_ID)
  })

  test('rate limit: writes spaced more than the debounce window apart but within ~2s of the previous reload collapse toward one callback per ~2s window', async () => {
    await writeStateFileDirect(JSON.stringify({ v: 0 }))
    const calls: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, c) => calls.push(c))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 }))

    // First external change fires immediately (no prior reload to rate-limit against).
    await writeStateFileDirect(JSON.stringify({ v: 1 }))
    await sleep(700)
    expect(calls.length).toBe(1)

    // A second change shortly after (well within the 2s rate-limit window) should be suppressed.
    await writeStateFileDirect(JSON.stringify({ v: 2 }))
    await sleep(700)
    expect(calls.length).toBe(1) // still 1 — rate-limited

    watcher.stop(PAWPRINT_ID, INSTANCE_ID)
  }, 10000)

  test('stop() closes the underlying watcher so a later external write produces no callback', async () => {
    await writeStateFileDirect(JSON.stringify({ v: 0 }))
    const calls: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, c) => calls.push(c))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 }))
    watcher.stop(PAWPRINT_ID, INSTANCE_ID)

    await writeStateFileDirect(JSON.stringify({ v: 1 }))
    await sleep(700)

    expect(calls.length).toBe(0)
  })

  test('starting the same instance twice is a no-op (does not throw or double-register)', async () => {
    await writeStateFileDirect(JSON.stringify({ v: 0 }))
    const calls: unknown[] = []
    const watcher = new PawprintStateWatcher((_pid, _iid, c) => calls.push(c))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 }))
    watcher.start(PAWPRINT_ID, INSTANCE_ID, JSON.stringify({ v: 0 })) // second start() — should be a no-op

    await writeStateFileDirect(JSON.stringify({ v: 1 }))
    await sleep(700)

    expect(calls.length).toBe(1) // exactly one callback, not two, confirming no double-registration
    watcher.stop(PAWPRINT_ID, INSTANCE_ID)
  })

  test('stopping an instance that was never started is a no-op, not a crash', () => {
    const watcher = new PawprintStateWatcher(() => {})
    expect(() => watcher.stop('nonexistent', 'nonexistent')).not.toThrow()
  })
})
