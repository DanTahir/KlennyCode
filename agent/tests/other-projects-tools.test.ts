import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers a shared electron mock — see that file for why this matters

let userDataDir: string
let otherProjectDir: string
let currentWorkspaceDir: string

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata2-'))
  otherProjectDir = await mkdtemp(join(tmpdir(), 'klenny-other-'))
  currentWorkspaceDir = await mkdtemp(join(tmpdir(), 'klenny-current-'))

  await mkdir(join(otherProjectDir, 'src'), { recursive: true })
  await writeFile(
    join(otherProjectDir, 'src', 'widget.ts'),
    'export function renderWidget() {\n  return "hello from the other project"\n}\n',
    'utf8'
  )

  const idOther = Buffer.from(otherProjectDir).toString('base64url')
  await mkdir(join(userDataDir, 'projects', idOther, 'memory'), { recursive: true })
  await writeFile(
    join(userDataDir, 'projects', idOther, 'memory', 'Widget feature.md'),
    '# Widget feature\n\nBuilt a reusable widget renderer.\n',
    'utf8'
  )
  await writeFile(
    join(userDataDir, 'projects', idOther, 'memory', 'MEMORY.md'),
    '# Memory Index\n- [Widget feature](Widget feature.md) — Built a reusable widget renderer.\n',
    'utf8'
  )
  await writeFile(join(otherProjectDir, 'KLENNY.md'), '# Other Project\nA test project.\n', 'utf8')

  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(currentWorkspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(userDataDir, { recursive: true, force: true })
  await rm(otherProjectDir, { recursive: true, force: true })
  await rm(currentWorkspaceDir, { recursive: true, force: true })
})

describe('cross-project reference (list_projects + global read_file/grep/glob + memory project arg)', () => {
  test('listProjectsTool surfaces the other project but not the current workspace', async () => {
    const { listProjectsTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await listProjectsTool()
    expect(result.ok).toBe(true)
    const projects = (result.data as { projects: string[] }).projects.map((p) => p.replace(/\\/g, '/').toLowerCase())
    expect(projects).toContain(otherProjectDir.replace(/\\/g, '/').toLowerCase())
    expect(projects).not.toContain(currentWorkspaceDir.replace(/\\/g, '/').toLowerCase())
  })

  test('read_file reads a file from a DIFFERENT project via an absolute path, with a current workspace open', async () => {
    const { readFileTool } = await import('../src/main/agent/tools/file-ops')
    const result = await readFileTool({ path: join(otherProjectDir, 'src', 'widget.ts') })
    expect(result.ok).toBe(true)
    const data = result.data as { content: string }
    expect(data.content).toContain('renderWidget')
  })

  test('glob finds files inside another project via an absolute cwd', async () => {
    const { globTool } = await import('../src/main/agent/tools/search')
    const result = await globTool({ pattern: '**/*.ts', cwd: otherProjectDir })
    expect(result.ok).toBe(true)
    const data = result.data as { files: string[] }
    expect(data.files.some((f) => f.includes('widget.ts'))).toBe(true)
  })

  test('grep finds matches inside another project via an absolute path', async () => {
    const { grepTool } = await import('../src/main/agent/tools/search')
    const result = await grepTool({ pattern: 'renderWidget', path: otherProjectDir })
    expect(result.ok).toBe(true)
    const data = result.data as { hits: Array<{ file: string; match: boolean }> }
    expect(data.hits.some((h) => h.match && h.file.includes('widget.ts'))).toBe(true)
  })

  test('resolveProjectOrError resolves a known project and rejects an unknown one', async () => {
    const { resolveProjectOrError } = await import('../src/main/agent/tools/otherProjects')
    const ok = await resolveProjectOrError(otherProjectDir)
    expect('root' in ok).toBe(true)
    const bad = await resolveProjectOrError('nonexistent-project-abc')
    expect('error' in bad).toBe(true)
    if ('error' in bad) expect(bad.error.error).toBe('unknown_project')
  })

  test('listMemoryTopics/loadProjectMemory/loadAutoMemoryIndex accept an explicit other-project workspace path', async () => {
    const { loadProjectMemory, loadAutoMemoryIndex, listMemoryTopics } = await import('../src/main/agent/memory/manager')
    const content = await loadProjectMemory(otherProjectDir)
    expect(content).toContain('Other Project')
    const autoIndex = await loadAutoMemoryIndex(otherProjectDir)
    expect(autoIndex).toContain('Widget feature')
    const topics = await listMemoryTopics('project', otherProjectDir)
    expect(topics).toContain('Widget feature')
  })

  test('readMemoryTopic reads a specific topic from another project when given its workspace path', async () => {
    const { readMemoryTopic } = await import('../src/main/agent/memory/manager')
    const content = await readMemoryTopic('project', 'Widget feature', otherProjectDir)
    expect(content).toContain('reusable widget renderer')
  })
})
