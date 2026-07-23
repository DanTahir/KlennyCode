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

describe('cross-project read-only tools', () => {
  test('listProjectsTool surfaces the other project but not the current workspace', async () => {
    const { listProjectsTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await listProjectsTool()
    expect(result.ok).toBe(true)
    const projects = (result.data as { projects: string[] }).projects.map((p) => p.replace(/\\/g, '/').toLowerCase())
    expect(projects).toContain(otherProjectDir.replace(/\\/g, '/').toLowerCase())
    expect(projects).not.toContain(currentWorkspaceDir.replace(/\\/g, '/').toLowerCase())
  })

  test('readOtherProjectFileTool reads a file from a known other project', async () => {
    const { readOtherProjectFileTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await readOtherProjectFileTool({ project: otherProjectDir, path: 'src/widget.ts' })
    expect(result.ok).toBe(true)
    const data = result.data as { content: string }
    expect(data.content).toContain('renderWidget')
  })

  test('readOtherProjectFileTool rejects an unknown project', async () => {
    const { readOtherProjectFileTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await readOtherProjectFileTool({ project: 'nonexistent-project-abc', path: 'src/widget.ts' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('unknown_project')
  })

  test('readOtherProjectFileTool rejects path traversal outside the resolved project root', async () => {
    const { readOtherProjectFileTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await readOtherProjectFileTool({ project: otherProjectDir, path: '../../../etc/passwd' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('sandbox')
  })

  test('globOtherProjectTool finds files inside the other project', async () => {
    const { globOtherProjectTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await globOtherProjectTool({ project: otherProjectDir, pattern: '**/*.ts' })
    expect(result.ok).toBe(true)
    const data = result.data as { files: string[] }
    expect(data.files.some((f) => f.includes('widget.ts'))).toBe(true)
  })

  test('grepOtherProjectTool finds matches inside the other project', async () => {
    const { grepOtherProjectTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await grepOtherProjectTool({ project: otherProjectDir, pattern: 'renderWidget' })
    expect(result.ok).toBe(true)
    const data = result.data as { hits: Array<{ file: string; match: boolean }> }
    expect(data.hits.some((h) => h.match && h.file.includes('widget.ts'))).toBe(true)
  })

  test('readOtherProjectMemoryTool returns the overview + topic list when no topic is given', async () => {
    const { readOtherProjectMemoryTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await readOtherProjectMemoryTool({ project: otherProjectDir, scope: 'project' })
    expect(result.ok).toBe(true)
    const data = result.data as { content: string; topics: string[] }
    expect(data.content).toContain('Other Project')
    expect(data.topics).toContain('Widget feature')
  })

  test('readOtherProjectMemoryTool returns a specific topic note when given one', async () => {
    const { readOtherProjectMemoryTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await readOtherProjectMemoryTool({ project: otherProjectDir, scope: 'project', topic: 'Widget feature' })
    expect(result.ok).toBe(true)
    const data = result.data as { content: string }
    expect(data.content).toContain('reusable widget renderer')
  })

  test('readOtherProjectMemoryTool rejects scope "global" (not project-specific)', async () => {
    const { readOtherProjectMemoryTool } = await import('../src/main/agent/tools/otherProjects')
    const result = await readOtherProjectMemoryTool({ project: otherProjectDir, scope: 'global' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('use_read_memory')
  })
})
