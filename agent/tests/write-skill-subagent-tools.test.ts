import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect the global Klenny dir (~/.klenny) to an isolated temp "home" so this test never
// touches the real user home directory. Must be mocked before dataDir.ts (which calls
// homedir() from node:os) is loaded anywhere in the process. Same pattern as
// skills-seeding.test.ts.
let fakeHome = ''

mock.module('node:os', () => ({
  homedir: () => fakeHome,
  tmpdir
}))

// Shared electron mock (getWorkspace() pulls in workspace.ts -> electron).
import './testElectronMock'

import { getToolDefinitions } from '../src/main/agent/tools/definitions'

describe('write_skill / write_subagent tool definitions', () => {
  test('are exposed in agent mode', () => {
    const tools = getToolDefinitions('agent').map((t) => t.function.name)
    expect(tools).toContain('write_skill')
    expect(tools).toContain('write_subagent')
  })

  test('are NOT exposed in plan mode (mutating, agent-mode only)', () => {
    const tools = getToolDefinitions('plan').map((t) => t.function.name)
    expect(tools).not.toContain('write_skill')
    expect(tools).not.toContain('write_subagent')
  })

  test('remain available with no workspace open (Assistant tab) — they don\'t need file I/O to be offered, though project scope still requires a workspace at call time', () => {
    const tools = getToolDefinitions('agent', 'all', false, false).map((t) => t.function.name)
    expect(tools).toContain('write_skill')
    expect(tools).toContain('write_subagent')
  })
})

describe('writeSkill manager guard + scoping', () => {
  let tempRoot: string
  let workspace: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-write-skill-'))
    fakeHome = join(tempRoot, 'home')
    workspace = join(tempRoot, 'project')
    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  afterEach(async () => {
    const { setWorkspace } = await import('../src/main/workspace')
    setWorkspace(null)
  })

  test('throws when scope is "project" and no workspace is open', async () => {
    const { writeSkill } = await import('../src/main/agent/skills/manager')
    await expect(writeSkill('no-ws-skill', 'project', 'desc', 'body')).rejects.toThrow(/workspace/i)
  })

  test('writes a global skill under the global Klenny dir', async () => {
    const { writeSkill, listSkills } = await import('../src/main/agent/skills/manager')
    await writeSkill('my-global-skill', 'global', 'A global skill', 'Do the thing.')
    const raw = await readFile(join(fakeHome, '.klenny', 'skills', 'my-global-skill', 'SKILL.md'), 'utf8')
    expect(raw).toContain('name: my-global-skill')
    expect(raw).toContain('Do the thing.')

    const skills = await listSkills()
    expect(skills.some((s) => s.name === 'my-global-skill' && s.scope === 'global')).toBe(true)
  })

  test('writes a project skill under .klenny/skills when a workspace is open', async () => {
    const { setWorkspace } = await import('../src/main/workspace')
    const { writeSkill, listSkills } = await import('../src/main/agent/skills/manager')
    setWorkspace(workspace)
    await writeSkill('my-project-skill', 'project', 'A project skill', 'Do the project thing.')
    const raw = await readFile(join(workspace, '.klenny', 'skills', 'my-project-skill', 'SKILL.md'), 'utf8')
    expect(raw).toContain('name: my-project-skill')

    const skills = await listSkills()
    expect(skills.some((s) => s.name === 'my-project-skill' && s.scope === 'project')).toBe(true)
  })
})

describe('writeSubagentType manager guard + scoping', () => {
  let tempRoot: string
  let workspace: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-write-subagent-'))
    fakeHome = join(tempRoot, 'home')
    workspace = join(tempRoot, 'project')
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  afterEach(async () => {
    const { setWorkspace } = await import('../src/main/workspace')
    setWorkspace(null)
  })

  test('throws when scope is "project" and no workspace is open', async () => {
    const { writeSubagentType } = await import('../src/main/agent/subagents/manager')
    await expect(
      writeSubagentType('no-ws-agent', 'project', 'desc', 'all', undefined, 'body')
    ).rejects.toThrow(/workspace/i)
  })

  test('refuses to overwrite a built-in subagent name', async () => {
    const { writeSubagentType } = await import('../src/main/agent/subagents/manager')
    await expect(
      writeSubagentType('explore', 'global', 'desc', 'all', undefined, 'body')
    ).rejects.toThrow(/built-in/i)
  })

  test('writes a global custom subagent under the global Klenny dir', async () => {
    const { writeSubagentType, listSubagentTypes } = await import('../src/main/agent/subagents/manager')
    await writeSubagentType('bug-hunter', 'global', 'Hunts bugs', ['read_file', 'grep'], undefined, 'Find bugs.')
    const raw = await readFile(join(fakeHome, '.klenny', 'agents', 'bug-hunter.md'), 'utf8')
    expect(raw).toContain('name: bug-hunter')
    expect(raw).toContain('Find bugs.')

    const types = await listSubagentTypes()
    const found = types.find((t) => t.name === 'bug-hunter')
    expect(found).toBeDefined()
    expect(found?.scope).toBe('global')
  })

  test('writes a project custom subagent under .klenny/agents when a workspace is open', async () => {
    const { setWorkspace } = await import('../src/main/workspace')
    const { writeSubagentType, listSubagentTypes } = await import('../src/main/agent/subagents/manager')
    setWorkspace(workspace)
    await writeSubagentType('proj-agent', 'project', 'Project-scoped agent', 'all', 'openai/gpt-4o', 'Do project stuff.')
    const raw = await readFile(join(workspace, '.klenny', 'agents', 'proj-agent.md'), 'utf8')
    expect(raw).toContain('name: proj-agent')
    expect(raw).toContain('model: openai/gpt-4o')

    const types = await listSubagentTypes()
    const found = types.find((t) => t.name === 'proj-agent')
    expect(found).toBeDefined()
    expect(found?.scope).toBe('project')
  })
})
