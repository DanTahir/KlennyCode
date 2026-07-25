import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnFn } from '../src/main/browser/installer'

/**
 * Isolates browser/installer.ts's Chromium-cache check so tests never depend on this machine's
 * actual Chromium install state: 'playwright' is mocked so `chromium.executablePath()` returns
 * a path inside a per-test temp dir, fully controllable via `fakeExecutablePath`.
 *
 * Deliberately does NOT mock 'node:child_process' — `mock.module` is process-global in Bun (see
 * testElectronMock.ts's warning), and other test files' tools (run_command, grep, etc.) really
 * do need to spawn real processes; a global child_process mock previously broke those with a
 * 5s timeout waiting on a fake, never-closing child. Instead, `ensureChromiumInstalled()` takes
 * an injectable `spawnFn` parameter (defaulting to the real `spawn` in production) — tests pass
 * a fake one directly, with zero risk of leaking into unrelated test files.
 */
let fakeExecutablePath = ''

mock.module('playwright', () => ({
  chromium: {
    executablePath: () => fakeExecutablePath
  }
}))

type FakeChild = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

function makeFakeSpawn(child: FakeChild): { spawnFn: SpawnFn; calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> } {
  const calls: Array<{ command: string; args: string[]; env: Record<string, string | undefined> }> = []
  const spawnFn = ((command: string, args: readonly string[], opts: { env?: Record<string, string | undefined> }) => {
    calls.push({ command, args: [...args], env: opts.env ?? {} })
    return child as unknown as ReturnType<SpawnFn>
  }) as unknown as SpawnFn
  return { spawnFn, calls }
}

describe('browser automation: lazy Chromium install', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'klenny-chromium-'))
    fakeExecutablePath = join(tempDir, 'chrome.exe')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('isChromiumInstalled() is false when the executable path does not exist', async () => {
    const { isChromiumInstalled } = await import('../src/main/browser/installer')
    expect(isChromiumInstalled()).toBe(false)
  })

  test('isChromiumInstalled() is true once a file exists at the executable path', async () => {
    await writeFile(fakeExecutablePath, 'fake binary', 'utf8')
    const { isChromiumInstalled } = await import('../src/main/browser/installer')
    expect(isChromiumInstalled()).toBe(true)
  })

  test('ensureChromiumInstalled() is a no-op (never spawns) when Chromium is already installed', async () => {
    await writeFile(fakeExecutablePath, 'fake binary', 'utf8')
    const { ensureChromiumInstalled } = await import('../src/main/browser/installer')
    const child = makeFakeChild()
    const { spawnFn, calls } = makeFakeSpawn(child)
    await ensureChromiumInstalled(undefined, spawnFn)
    expect(calls.length).toBe(0)
  })

  test('ensureChromiumInstalled() spawns the Playwright CLI with ELECTRON_RUN_AS_NODE and reports progress on success', async () => {
    const { ensureChromiumInstalled } = await import('../src/main/browser/installer')
    const child = makeFakeChild()
    const { spawnFn, calls } = makeFakeSpawn(child)

    const progressMessages: string[] = []
    const installing = ensureChromiumInstalled((m) => progressMessages.push(m), spawnFn)

    // Let the microtask queue advance so spawnFn has been called before we drive the fake child.
    await Promise.resolve()
    expect(calls.length).toBe(1)
    expect(calls[0].args).toContain('install')
    expect(calls[0].args).toContain('chromium')
    expect(calls[0].env.ELECTRON_RUN_AS_NODE).toBe('1')

    child.stdout.emit('data', Buffer.from('Downloading Chromium 45%\r'))
    child.emit('close', 0)

    await installing
    expect(progressMessages.some((m) => m.includes('Downloading Chromium'))).toBe(true)
    expect(progressMessages.some((m) => m.toLowerCase().includes('complete'))).toBe(true)
  })

  test('ensureChromiumInstalled() rejects with a descriptive error when the install process exits non-zero', async () => {
    const { ensureChromiumInstalled } = await import('../src/main/browser/installer')
    const child = makeFakeChild()
    const { spawnFn } = makeFakeSpawn(child)

    const installing = ensureChromiumInstalled(undefined, spawnFn)
    await Promise.resolve()
    child.stderr.emit('data', Buffer.from('network error downloading chromium'))
    child.emit('close', 1)

    await expect(installing).rejects.toThrow(/network error downloading chromium|exited with code 1/)
  })

  test('concurrent ensureChromiumInstalled() calls share a single install (spawn called once)', async () => {
    const { ensureChromiumInstalled } = await import('../src/main/browser/installer')
    const child = makeFakeChild()
    const { spawnFn, calls } = makeFakeSpawn(child)

    const first = ensureChromiumInstalled(undefined, spawnFn)
    const second = ensureChromiumInstalled(undefined, spawnFn)
    await Promise.resolve()
    expect(calls.length).toBe(1)

    child.emit('close', 0)
    await Promise.all([first, second])
    expect(calls.length).toBe(1)
  })
})
