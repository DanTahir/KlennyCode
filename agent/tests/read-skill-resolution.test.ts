import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Shared mocks (must be imported before anything pulling in node:os/electron transitively).
import { homeMockState } from './testHomeMock'
import './testElectronMock'

/**
 * Regression tests for read_skill resolving a skill by NAME, not just by exact path.
 *
 * The bug: the skills catalog in the system prompt lists skills as `name (scope): description`
 * and deliberately omits absolute paths, but readSkill() required an exact filesystem path. So
 * the model's first read_skill call was always a guess (usually the bare name), it threw ENOENT,
 * and it had to call list_skills to recover the real path before retrying — an avoidable failed
 * call plus an extra round-trip before every single skill read.
 */
describe('read_skill reference resolution', () => {
  let fakeHome: string
  let workspaceDir: string

  const globalSkill = (name: string) => join(fakeHome, '.klenny', 'skills', name, 'SKILL.md')
  const projectSkill = (name: string) => join(workspaceDir, '.klenny', 'skills', name, 'SKILL.md')

  async function writeSkillFile(path: string, name: string, description: string, body: string) {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8')
  }

  beforeAll(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'klenny-readskill-home-'))
    workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-readskill-ws-'))
    homeMockState.homeDir = fakeHome

    const { setWorkspace } = await import('../src/main/workspace')
    setWorkspace(workspaceDir)

    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()

    await writeSkillFile(projectSkill('proj-only'), 'proj-only', 'A project skill', 'PROJECT BODY')
    await writeSkillFile(globalSkill('glob-only'), 'glob-only', 'A global skill', 'GLOBAL BODY')
    // Same name in both scopes — used to check precedence and the scope hint.
    await writeSkillFile(projectSkill('dupe'), 'dupe', 'Project dupe', 'DUPE PROJECT BODY')
    await writeSkillFile(globalSkill('dupe'), 'dupe', 'Global dupe', 'DUPE GLOBAL BODY')
    // Directory name differs from the frontmatter name — both should resolve.
    await writeSkillFile(globalSkill('dir-name'), 'front-name', 'Mismatched', 'MISMATCH BODY')
  })

  afterAll(async () => {
    const { setWorkspace } = await import('../src/main/workspace')
    setWorkspace(null) // don't leak workspace state into other files sharing this process
    await rm(fakeHome, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  })

  test('resolves a bare project-scoped skill name (the original failing case)', async () => {
    const { readSkillDetailed } = await import('../src/main/agent/skills/manager')
    const skill = await readSkillDetailed('proj-only')
    expect(skill.content).toBe('PROJECT BODY')
    expect(skill.scope).toBe('project')
    expect(skill.path).toBe(projectSkill('proj-only'))
  })

  test('resolves a bare global-scoped skill name', async () => {
    const { readSkillDetailed } = await import('../src/main/agent/skills/manager')
    const skill = await readSkillDetailed('glob-only')
    expect(skill.content).toBe('GLOBAL BODY')
    expect(skill.scope).toBe('global')
  })

  test('name matching is case-insensitive and tolerates quotes/whitespace', async () => {
    const { readSkillDetailed } = await import('../src/main/agent/skills/manager')
    expect((await readSkillDetailed('  GLOB-Only ')).content).toBe('GLOBAL BODY')
    expect((await readSkillDetailed('"glob-only"')).content).toBe('GLOBAL BODY')
    expect((await readSkillDetailed('`glob-only`')).content).toBe('GLOBAL BODY')
  })

  test('accepts a catalog line pasted verbatim, honoring its (scope) hint', async () => {
    const { readSkillDetailed } = await import('../src/main/agent/skills/manager')
    // Exactly the shape the system-prompt catalog renders.
    const fromCatalog = await readSkillDetailed('dupe (global): Global dupe')
    expect(fromCatalog.content).toBe('DUPE GLOBAL BODY')
    expect(fromCatalog.scope).toBe('global')

    const scopeOnly = await readSkillDetailed('dupe (project)')
    expect(scopeOnly.content).toBe('DUPE PROJECT BODY')
    expect(scopeOnly.scope).toBe('project')
  })

  test('project scope wins over global for an ambiguous bare name', async () => {
    const { readSkillDetailed } = await import('../src/main/agent/skills/manager')
    const skill = await readSkillDetailed('dupe')
    expect(skill.scope).toBe('project')
    expect(skill.content).toBe('DUPE PROJECT BODY')
  })

  test('matches either the frontmatter name or the containing directory name', async () => {
    const { readSkillDetailed } = await import('../src/main/agent/skills/manager')
    expect((await readSkillDetailed('front-name')).content).toBe('MISMATCH BODY')
    expect((await readSkillDetailed('dir-name')).content).toBe('MISMATCH BODY')
  })

  test('still accepts an exact path from list_skills (backward compatibility)', async () => {
    const { listSkills, readSkillDetailed, readSkill } = await import('../src/main/agent/skills/manager')
    const skills = await listSkills()
    const target = skills.find((s) => s.name === 'glob-only')
    expect(target).toBeDefined()
    expect((await readSkillDetailed(target!.path)).content).toBe('GLOBAL BODY')
    // readSkill() keeps its original string-content contract (used by the IPC/renderer path).
    expect(await readSkill(target!.path)).toBe('GLOBAL BODY')
  })

  test('accepts a skill directory path (SKILL.md implied) and a relative path', async () => {
    const { readSkillDetailed } = await import('../src/main/agent/skills/manager')
    const dirPath = join(fakeHome, '.klenny', 'skills', 'glob-only')
    expect((await readSkillDetailed(dirPath)).content).toBe('GLOBAL BODY')

    // Workspace-relative form, e.g. what a model might construct for a project skill.
    const rel = join('.klenny', 'skills', 'proj-only', 'SKILL.md')
    expect((await readSkillDetailed(rel)).content).toBe('PROJECT BODY')
  })

  test('unknown skill throws an actionable error listing available skills', async () => {
    const { readSkillDetailed } = await import('../src/main/agent/skills/manager')
    let message = ''
    try {
      await readSkillDetailed('no-such-skill')
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }
    expect(message).toContain('no-such-skill')
    expect(message).toContain('Available skills')
    // The listing is what lets the model self-correct without a separate list_skills call.
    expect(message).toContain('proj-only')
    expect(message).toContain('glob-only')
  })

  test('empty/missing ref does not resolve to some arbitrary skill', async () => {
    const { resolveSkill } = await import('../src/main/agent/skills/manager')
    expect(await resolveSkill('')).toBeNull()
    expect(await resolveSkill(undefined)).toBeNull()
    expect(await resolveSkill('   ')).toBeNull()
  })

  test('catalog prompt tells the model to pass a name, not a path', async () => {
    const { listSkills, skillsCatalogPrompt } = await import('../src/main/agent/skills/manager')
    const prompt = skillsCatalogPrompt(await listSkills())
    expect(prompt).toContain('Available skills')
    expect(prompt).toContain("read_skill with the skill's name")
  })
})
