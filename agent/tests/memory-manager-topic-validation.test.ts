import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere

let workspaceDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-memtopic-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-memtopic-'))
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('writeMemory topic validation', () => {
  test('rejects a project-scope topic containing a forward slash instead of writing anywhere', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    await expect(writeMemory('project', 'features/shell-selection', 'some content')).rejects.toThrow(/illegal/i)
  })

  test('rejects a global-scope topic containing a backslash', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    await expect(writeMemory('global', 'features\\shell-selection', 'some content')).rejects.toThrow(/illegal/i)
  })

  test('rejects an empty topic', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    await expect(writeMemory('project', '', 'some content')).rejects.toThrow(/non-empty/i)
  })

  test('accepts a plain topic title with no path separators', async () => {
    const { writeMemory, loadAutoMemoryIndex } = await import('../src/main/agent/memory/manager')
    await writeMemory('project', 'Shell selection feature', 'Implemented shell selection.\n')
    const index = await loadAutoMemoryIndex(workspaceDir)
    expect(index).toContain('Shell selection feature')

    const { projectDataDir } = await import('../src/main/dataDir')
    const notePath = join(projectDataDir(workspaceDir), 'memory', 'Shell selection feature.md')
    expect(await readFile(notePath, 'utf8')).toBe('Implemented shell selection.\n')
  })
})
