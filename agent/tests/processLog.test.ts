import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import './testElectronMock'
import { electronMockState } from './testElectronMock'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  appendProcessLog,
  appendProcessLogMarker,
  readProcessLog,
  flushProcessLog,
  installProcessLogTee,
  uninstallProcessLogTee
} = await import('../src/main/processLog')

const tempDirs: string[] = []

beforeEach(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-processlog-'))
  tempDirs.push(userDataDir)
  electronMockState.userDataDir = userDataDir
})

afterEach(async () => {
  // Always restore the real writers, or a failing test would leave the tee installed and start
  // capturing the test runner's own output into whatever temp dir came last.
  uninstallProcessLogTee()
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

function logPath(): string {
  return join(electronMockState.userDataDir, 'process.log')
}

describe('appendProcessLog / readProcessLog', () => {
  test('returns empty string when nothing has been captured yet', async () => {
    expect(await readProcessLog()).toBe('')
  })

  test('round-trips app output through the log file', async () => {
    appendProcessLog('hello from main\n')
    appendProcessLog('second line\n')
    await flushProcessLog()
    const content = await readProcessLog()
    expect(content).toContain('hello from main')
    expect(content).toContain('second line')
  })

  test('strips ANSI codes before writing to disk', async () => {
    appendProcessLog('\u001b[33m[cache] request\u001b[0m\n')
    await flushProcessLog()
    const raw = await readFile(logPath(), 'utf8')
    expect(raw).not.toContain('\u001b')
    expect(raw).toContain('[cache] request')
  })

  test('markers bracket the log with app-run boundaries', async () => {
    appendProcessLogMarker('App session started (pid 123)')
    appendProcessLog('doing work\n')
    await flushProcessLog()
    const content = await readProcessLog()
    expect(content).toContain('=== App session started (pid 123) ===')
    expect(content).toContain('doing work')
  })

  test('caps returned lines to the tail of the file', async () => {
    for (let i = 0; i < 50; i++) appendProcessLog(`line ${i}\n`)
    await flushProcessLog()
    const content = await readProcessLog({ lines: 5 })
    expect(content.split('\n').filter(Boolean).length).toBeLessThanOrEqual(5)
    expect(content).toContain('line 49')
    expect(content).not.toContain('line 0\n')
  })

  test('rotates the log back down once it exceeds the size cap', async () => {
    const bigChunk = 'x'.repeat(1024 * 1024) + '\n' // 1MB
    appendProcessLog(bigChunk)
    appendProcessLog(bigChunk)
    appendProcessLog(bigChunk) // ~3MB, over the 2MB cap
    appendProcessLog('tail marker\n')
    await flushProcessLog()
    const raw = await readFile(logPath(), 'utf8')
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(2 * 1024 * 1024)
    expect(raw).toContain('tail marker')
    expect(raw).toContain('trimmed')
  })
})

describe('readProcessLog filtering', () => {
  test('returns only matching lines, case-insensitively', async () => {
    appendProcessLog('[cache] request model=x breakpointsAt=[0,31,34]\n')
    appendProcessLog('some unrelated chatter\n')
    appendProcessLog('[CACHE] usage cachedTokens=98799\n')
    await flushProcessLog()
    const content = await readProcessLog({ filter: '[cache]' })
    expect(content).toContain('breakpointsAt=[0,31,34]')
    expect(content).toContain('cachedTokens=98799')
    expect(content).not.toContain('unrelated chatter')
  })

  test('the line cap applies to matching lines, not to the raw tail', async () => {
    // 40 noise lines AFTER the interesting ones: an unfiltered tail read of 5 lines would miss
    // them entirely, so this pins that filtering happens before the tail slice.
    appendProcessLog('[cache] first interesting\n')
    appendProcessLog('[cache] second interesting\n')
    for (let i = 0; i < 40; i++) appendProcessLog(`noise ${i}\n`)
    await flushProcessLog()
    const content = await readProcessLog({ filter: '[cache]', lines: 5 })
    expect(content).toContain('first interesting')
    expect(content).toContain('second interesting')
    expect(content).not.toContain('noise 39')
  })
})

describe('installProcessLogTee', () => {
  test('captures process.stdout.write and console.log', async () => {
    installProcessLogTee()
    process.stdout.write('written directly to stdout\n')
    console.log('logged via console')
    uninstallProcessLogTee()

    await flushProcessLog()
    const content = await readProcessLog()
    expect(content).toContain('written directly to stdout')
    expect(content).toContain('logged via console')
  })

  test('captures a console.log line EXACTLY once, not twice', async () => {
    // The cross-runtime trap this pins: on Node/Electron the global console writes through
    // process.stdout, so patching the console AND the stream would record the same line twice
    // (suppressStreamCapture is what prevents it); under Bun the console bypasses the stream, so
    // the console patch is the only thing that captures it at all. Exactly-once must hold on both.
    installProcessLogTee()
    console.log('[cache] usage cachedTokens=12345')
    uninstallProcessLogTee()

    await flushProcessLog()
    const occurrences = (await readProcessLog()).split('cachedTokens=12345').length - 1
    expect(occurrences).toBe(1)
  })

  test('formats console arguments the way console itself does', async () => {
    installProcessLogTee()
    console.log('[cache] model=%s cached=%d', 'anthropic/claude-opus-5', 98799)
    console.error('failed:', { code: 400 })
    uninstallProcessLogTee()

    await flushProcessLog()
    const content = await readProcessLog()
    expect(content).toContain('[cache] model=anthropic/claude-opus-5 cached=98799')
    expect(content).toContain('code: 400')
  })

  test('captures stderr too', async () => {
    installProcessLogTee()
    process.stderr.write('a failure happened\n')
    uninstallProcessLogTee()

    await flushProcessLog()
    expect(await readProcessLog()).toContain('a failure happened')
  })

  test('still captures when the underlying write throws (packaged build with no console)', async () => {
    // The real reason the tee captures before delegating: a packaged Windows GUI build has no
    // attached console, so the underlying write can throw (EPIPE/EBADF). The log must still be
    // complete, and the throw must not propagate to the caller's console.log.
    const realWrite = process.stdout.write.bind(process.stdout)
    ;(process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = () => {
      throw new Error('EBADF: no console attached')
    }
    installProcessLogTee()
    expect(() => process.stdout.write('survives a dead stdout\n')).not.toThrow()
    uninstallProcessLogTee()
    ;(process.stdout as unknown as { write: typeof realWrite }).write = realWrite

    await flushProcessLog()
    expect(await readProcessLog()).toContain('survives a dead stdout')
  })

  test('is idempotent — a second install does not double every line', async () => {
    installProcessLogTee()
    installProcessLogTee()
    process.stdout.write('exactly once\n')
    uninstallProcessLogTee()

    await flushProcessLog()
    const occurrences = (await readProcessLog()).split('exactly once').length - 1
    expect(occurrences).toBe(1)
  })

  test('uninstall restores the original writer so nothing further is captured', async () => {
    installProcessLogTee()
    process.stdout.write('captured\n')
    uninstallProcessLogTee()
    process.stdout.write('not captured\n')

    await flushProcessLog()
    const content = await readProcessLog()
    expect(content).toContain('captured')
    expect(content).not.toContain('not captured')
  })
})
