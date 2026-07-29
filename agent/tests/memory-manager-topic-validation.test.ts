import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This file exercises 'global' scope (~/.klenny) via the second test below — see testHomeMock.ts
// for why the shared node:os home mock (not a locally-declared one) must be used.
import { homeMockState } from './testHomeMock'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere

let workspaceDir: string
let fakeHomeDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-memtopic-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-memtopic-'))
  fakeHomeDir = await mkdtemp(join(tmpdir(), 'klenny-fakehome-memtopic-'))
  homeMockState.homeDir = fakeHomeDir
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
  await rm(fakeHomeDir, { recursive: true, force: true })
})

describe('writeMemory topic sanitization', () => {
  test('sanitizes a project-scope topic containing a forward slash instead of throwing', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    const { projectDataDir } = await import('../src/main/dataDir')

    const saved = await writeMemory('project', 'features/shell-selection', 'some content')
    expect(saved).not.toContain('/')
    expect(saved).not.toContain('\\')

    const memDir = join(projectDataDir(workspaceDir), 'memory')
    const files = await readdir(memDir)
    expect(files).toContain(`${saved}.md`)
    expect(await readFile(join(memDir, `${saved}.md`), 'utf8')).toBe('some content')
  })

  test('sanitizes a global-scope topic containing a backslash', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    const saved = await writeMemory('global', 'features\\shell-selection', 'some content')
    expect(saved).not.toContain('/')
    expect(saved).not.toContain('\\')
  })

  test('sanitizes other filesystem-illegal characters (colons, wildcards, quotes, pipes)', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    const saved = await writeMemory('project', 'weird: name*with?illegal<chars>|"here"', 'content')
    expect(saved).not.toMatch(/[/\\:*?"<>|]/)
  })

  test('falls back to a default name when nothing usable survives sanitization', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    const saved = await writeMemory('project', '///\\\\\\', 'content')
    expect(saved).toBe('Untitled memory')
  })

  test('rejects an empty topic', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    await expect(writeMemory('project', '', 'some content')).rejects.toThrow(/non-empty/i)
  })

  test('accepts a plain topic title with no path separators unchanged', async () => {
    const { writeMemory, loadAutoMemoryIndex } = await import('../src/main/agent/memory/manager')
    const saved = await writeMemory('project', 'Shell selection feature', 'Implemented shell selection.\n')
    expect(saved).toBe('Shell selection feature')
    const index = await loadAutoMemoryIndex(workspaceDir)
    expect(index).toContain('Shell selection feature')

    const { projectDataDir } = await import('../src/main/dataDir')
    const notePath = join(projectDataDir(workspaceDir), 'memory', 'Shell selection feature.md')
    expect(await readFile(notePath, 'utf8')).toBe('Implemented shell selection.\n')
  })

  test('readMemoryTopic can read back a note using the original unsanitized topic name', async () => {
    const { writeMemory, readMemoryTopic } = await import('../src/main/agent/memory/manager')
    const requested = 'nested/topic/name'
    const saved = await writeMemory('project', requested, 'nested content')
    const content = await readMemoryTopic('project', requested, workspaceDir)
    expect(content).toBe('nested content')
    const contentBySavedName = await readMemoryTopic('project', saved, workspaceDir)
    expect(contentBySavedName).toBe('nested content')
  })
})
