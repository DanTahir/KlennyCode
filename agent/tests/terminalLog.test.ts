import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import './testElectronMock'
import { electronMockState } from './testElectronMock'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { stripAnsi, appendTerminalLog, appendTerminalLogMarker, readTerminalLog } = await import(
  '../src/main/terminalLog'
)
const { projectDataDir } = await import('../src/main/dataDir')

const tempDirs: string[] = []
let workspace: string

beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-termlog-'))
  workspace = await mkdtemp(join(tmpdir(), 'klenny-workspace-termlog-'))
  tempDirs.push(userDataDir, workspace)
  electronMockState.userDataDir = userDataDir
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

// Waits for any pending queued writes for this workspace to flush, since appendTerminalLog is
// fire-and-forget by design (never awaited by its callers, so tests must poll/settle instead).
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20))
}

describe('stripAnsi', () => {
  test('removes color escape codes', () => {
    expect(stripAnsi('\u001b[31mred text\u001b[0m')).toBe('red text')
  })

  test('removes cursor-movement sequences', () => {
    expect(stripAnsi('\u001b[2Kfoo\u001b[1A')).toBe('foo')
  })

  test('leaves plain text untouched', () => {
    expect(stripAnsi('plain text, no escapes')).toBe('plain text, no escapes')
  })
})

describe('appendTerminalLog / readTerminalLog', () => {
  test('returns empty string when no log exists yet', async () => {
    expect(await readTerminalLog(workspace)).toBe('')
  })

  test('round-trips plain output through the log file', async () => {
    appendTerminalLog(workspace, 'hello\n')
    appendTerminalLog(workspace, 'world\n')
    await flush()
    const content = await readTerminalLog(workspace)
    expect(content).toContain('hello')
    expect(content).toContain('world')
  })

  test('strips ANSI codes before writing to disk', async () => {
    appendTerminalLog(workspace, '\u001b[32mgreen\u001b[0m\n')
    await flush()
    const raw = await readFile(join(projectDataDir(workspace), 'terminal.log'), 'utf8')
    expect(raw).not.toContain('\u001b')
    expect(raw).toContain('green')
  })

  test('markers bracket the log with session boundaries', async () => {
    appendTerminalLogMarker(workspace, 'Terminal session started (bash)')
    appendTerminalLog(workspace, 'echo hi\n')
    appendTerminalLogMarker(workspace, 'Terminal session ended (exit 0)')
    await flush()
    const content = await readTerminalLog(workspace)
    expect(content).toContain('=== Terminal session started (bash) ===')
    expect(content).toContain('echo hi')
    expect(content).toContain('=== Terminal session ended (exit 0) ===')
  })

  test('readTerminalLog caps the number of returned lines to the tail of the file', async () => {
    for (let i = 0; i < 50; i++) appendTerminalLog(workspace, `line ${i}\n`)
    await flush()
    const content = await readTerminalLog(workspace, 5)
    const lines = content.split('\n').filter(Boolean)
    expect(lines.length).toBeLessThanOrEqual(5)
    expect(content).toContain('line 49')
    expect(content).not.toContain('line 0\n')
  })

  test('two workspaces get independent log files', async () => {
    const otherWorkspace = await mkdtemp(join(tmpdir(), 'klenny-workspace-termlog-other-'))
    tempDirs.push(otherWorkspace)

    appendTerminalLog(workspace, 'from workspace A\n')
    appendTerminalLog(otherWorkspace, 'from workspace B\n')
    await flush()

    const a = await readTerminalLog(workspace)
    const b = await readTerminalLog(otherWorkspace)
    expect(a).toContain('from workspace A')
    expect(a).not.toContain('from workspace B')
    expect(b).toContain('from workspace B')
    expect(b).not.toContain('from workspace A')
  })

  test('rotates the log back down once it exceeds the size cap', async () => {
    // Push well past the 2MB cap with a single large chunk so this test stays fast.
    const bigChunk = 'x'.repeat(1024 * 1024) + '\n' // 1MB
    appendTerminalLog(workspace, bigChunk)
    appendTerminalLog(workspace, bigChunk)
    appendTerminalLog(workspace, bigChunk) // now ~3MB total, over the 2MB cap
    appendTerminalLog(workspace, 'tail marker\n')
    // Rotation involves reading/rewriting a couple of MB of data on top of several queued
    // appends — give it more headroom than the default flush() before asserting on the result.
    await new Promise((r) => setTimeout(r, 300))
    const raw = await readFile(join(projectDataDir(workspace), 'terminal.log'), 'utf8')
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(2 * 1024 * 1024)
    expect(raw).toContain('tail marker')
    expect(raw).toContain('trimmed')
  })
})
