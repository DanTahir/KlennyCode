import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers a shared electron mock — see that file for why this matters

// projectsRegistry.ts imports `app` from electron (only for getPath('userData')) and
// `getWorkspace` from workspace.ts — stub electron out and let the real workspace module
// run (it defaults to no workspace open, which is fine for these tests).
let userDataDir: string
let projectADir: string
let projectBDir: string

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-'))
  projectADir = await mkdtemp(join(tmpdir(), 'klenny-projA-'))
  projectBDir = await mkdtemp(join(tmpdir(), 'klenny-projB-'))
  await mkdir(join(projectADir, 'src'), { recursive: true })
  await writeFile(join(projectADir, 'src', 'feature.ts'), 'export const FEATURE = true\n', 'utf8')

  electronMockState.userDataDir = userDataDir

  // Simulate: project A has generated memory/plan data (projects/<id>/), project B only
  // ever had a chat session (sessions/<id>.json) — both should be discoverable.
  const idA = Buffer.from(projectADir).toString('base64url')
  const idB = Buffer.from(projectBDir).toString('base64url')
  await mkdir(join(userDataDir, 'projects', idA, 'memory'), { recursive: true })
  await mkdir(join(userDataDir, 'sessions'), { recursive: true })
  await writeFile(join(userDataDir, 'sessions', `${idB}.json`), '[]', 'utf8')
})

afterAll(async () => {
  await rm(userDataDir, { recursive: true, force: true })
  await rm(projectADir, { recursive: true, force: true })
  await rm(projectBDir, { recursive: true, force: true })
})

describe('projectsRegistry', () => {
  test('listKnownProjects finds projects from both the projects/ and sessions/ dirs, deduped', async () => {
    const { listKnownProjects } = await import('../src/main/projectsRegistry')
    const known = await listKnownProjects()
    const normalized = known.map((p) => p.replace(/\\/g, '/').toLowerCase())
    expect(normalized).toContain(projectADir.replace(/\\/g, '/').toLowerCase())
    expect(normalized).toContain(projectBDir.replace(/\\/g, '/').toLowerCase())
  })

  test('listKnownProjects excludes paths that no longer exist on disk', async () => {
    const { listKnownProjects } = await import('../src/main/projectsRegistry')
    // The registry entry itself (projects/<id>/memory) exists, but the *decoded workspace
    // path* it points at was never created — this simulates a project folder that got
    // deleted/moved after Klenny last generated data for it.
    const ghostWorkspace = join(tmpdir(), 'klenny-does-not-exist-xyz')
    const ghostId = Buffer.from(ghostWorkspace).toString('base64url')
    await mkdir(join(userDataDir, 'projects', ghostId, 'memory'), { recursive: true })
    const known = await listKnownProjects()
    expect(known.some((p) => p.includes('does-not-exist-xyz'))).toBe(false)
  })

  test('resolveKnownProject matches an exact path', async () => {
    const { resolveKnownProject } = await import('../src/main/projectsRegistry')
    const resolved = await resolveKnownProject(projectADir)
    expect(resolved?.replace(/\\/g, '/').toLowerCase()).toBe(projectADir.replace(/\\/g, '/').toLowerCase())
  })

  test('resolveKnownProject matches an unambiguous basename', async () => {
    const { resolveKnownProject } = await import('../src/main/projectsRegistry')
    const basename = projectADir.replace(/\\/g, '/').split('/').pop()!
    const resolved = await resolveKnownProject(basename)
    expect(resolved?.replace(/\\/g, '/').toLowerCase()).toBe(projectADir.replace(/\\/g, '/').toLowerCase())
  })

  test('resolveKnownProject returns null for an unknown project reference', async () => {
    const { resolveKnownProject } = await import('../src/main/projectsRegistry')
    const resolved = await resolveKnownProject('totally-unknown-project-name')
    expect(resolved).toBeNull()
  })

  test('isPathInsideRoot rejects paths outside the given root (path traversal guard)', async () => {
    const { isPathInsideRoot } = await import('../src/main/projectsRegistry')
    expect(isPathInsideRoot(join(projectADir, 'src', 'feature.ts'), projectADir)).toBe(true)
    expect(isPathInsideRoot(projectBDir, projectADir)).toBe(false)
    expect(isPathInsideRoot(projectADir + '-evil-sibling', projectADir)).toBe(false)
  })
})
