// Covers the "always-allowed mutation roots" feature: write_file/edit_file/multi_edit/
// delete_file (and write_docx/edit_docx) must be able to mutate the global `~/.klenny` dir and
// the Electron `userData` dir even with no project workspace open (or, for Assistant tabs, a
// path outside their documentsDirectory root) — see assertMutationAllowed/
// alwaysAllowedMutationRoots in workspace.ts. This is what lets the agent maintain its own
// config/state (SOUL.md, global skills/subagents, settings, etc) directly through the normal
// file tools instead of hacky terminal workarounds.
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homeMockState } from './testHomeMock' // must load before dataDir.ts (via workspace.ts) is first imported
import { electronMockState } from './testElectronMock' // same ordering requirement for the electron mock

let userDataDir: string
let fakeHome: string
let workspaceDir: string
let outsideDir: string

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'klenny-global-sandbox-userdata-'))
  fakeHome = await mkdtemp(join(tmpdir(), 'klenny-global-sandbox-home-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-global-sandbox-ws-'))
  outsideDir = await mkdtemp(join(tmpdir(), 'klenny-global-sandbox-outside-'))

  electronMockState.userDataDir = userDataDir
  homeMockState.homeDir = fakeHome
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null)
  await rm(userDataDir, { recursive: true, force: true })
  await rm(fakeHome, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
  await rm(outsideDir, { recursive: true, force: true })
})

describe('alwaysAllowedMutationRoots', () => {
  test('returns the global ~/.klenny dir and the Electron userData dir', async () => {
    const { alwaysAllowedMutationRoots } = await import('../src/main/workspace')
    const roots = alwaysAllowedMutationRoots()
    expect(roots).toContain(join(fakeHome, '.klenny'))
    expect(roots).toContain(userDataDir)
  })
})

describe('assertMutationAllowed', () => {
  test('allows a path under the global Klenny dir with no workspace open', async () => {
    const { assertMutationAllowed, setWorkspace } = await import('../src/main/workspace')
    setWorkspace(null)
    expect(assertMutationAllowed(join(fakeHome, '.klenny', 'SOUL.md'))).toBe(true)
  })

  test('allows a path under the Electron userData dir with no workspace open', async () => {
    const { assertMutationAllowed, setWorkspace } = await import('../src/main/workspace')
    setWorkspace(null)
    expect(assertMutationAllowed(join(userDataDir, 'settings.json'))).toBe(true)
  })

  test('still allows global paths when a project workspace IS open (not workspace-exclusive)', async () => {
    const { assertMutationAllowed, setWorkspace } = await import('../src/main/workspace')
    setWorkspace(workspaceDir)
    expect(assertMutationAllowed(join(fakeHome, '.klenny', 'KLENNY.md'))).toBe(true)
  })

  test('still allows global paths for an Assistant-tab root (root param given, not just workspace)', async () => {
    const { assertMutationAllowed, setWorkspace } = await import('../src/main/workspace')
    setWorkspace(null)
    // root simulates AppSettings.documentsDirectory for an Assistant tab.
    expect(assertMutationAllowed(join(fakeHome, '.klenny', 'skills', 'x', 'SKILL.md'), outsideDir)).toBe(true)
  })

  test('still rejects a path outside both the workspace and the global roots', async () => {
    const { assertMutationAllowed, setWorkspace } = await import('../src/main/workspace')
    setWorkspace(workspaceDir)
    expect(assertMutationAllowed(join(outsideDir, 'not-allowed.txt'))).toBe(false)
  })

  test('still allows an ordinary path inside the open workspace', async () => {
    const { assertMutationAllowed, setWorkspace } = await import('../src/main/workspace')
    setWorkspace(workspaceDir)
    expect(assertMutationAllowed(join(workspaceDir, 'src', 'index.ts'))).toBe(true)
  })
})

describe('writeFileTool / editFileTool / deleteFileTool against the global Klenny dir', () => {
  test('write_file creates a file under ~/.klenny with no workspace open', async () => {
    const { setWorkspace } = await import('../src/main/workspace')
    setWorkspace(null)
    const { writeFileTool } = await import('../src/main/agent/tools/file-ops')
    const abs = join(fakeHome, '.klenny', 'SOUL.md')
    const result = await writeFileTool({ path: abs, content: 'I am a test persona.\n' })
    expect(result.ok).toBe(true)
    expect(await readFile(abs, 'utf8')).toBe('I am a test persona.\n')
  })

  test('edit_file can then modify that same file', async () => {
    const { editFileTool } = await import('../src/main/agent/tools/file-ops')
    const abs = join(fakeHome, '.klenny', 'SOUL.md')
    const result = await editFileTool({ path: abs, old_string: 'test persona', new_string: 'updated persona' })
    expect(result.ok).toBe(true)
    expect(await readFile(abs, 'utf8')).toBe('I am a updated persona.\n')
  })

  test('delete_file can remove a file under the Electron userData dir', async () => {
    const { writeFileTool, deleteFileTool } = await import('../src/main/agent/tools/file-ops')
    const abs = join(userDataDir, 'scratch.txt')
    await writeFileTool({ path: abs, content: 'scratch\n' })
    const result = await deleteFileTool({ path: abs })
    expect(result.ok).toBe(true)
    await expect(readFile(abs, 'utf8')).rejects.toThrow()
  })

  test('write_file still rejects a path outside both the workspace and the global roots', async () => {
    const { setWorkspace } = await import('../src/main/workspace')
    setWorkspace(workspaceDir)
    const { writeFileTool } = await import('../src/main/agent/tools/file-ops')
    const result = await writeFileTool({ path: join(outsideDir, 'nope.txt'), content: 'nope\n' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('sandbox')
  })
})
