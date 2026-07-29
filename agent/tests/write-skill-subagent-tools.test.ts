import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect the global Klenny dir (~/.klenny) to an isolated temp "home" so this test never
// touches the real user home directory — see testHomeMock.ts for why the shared mock (not a
// locally-declared one) must be used.
import { homeMockState } from './testHomeMock'

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

describe('read_subagent tool definition', () => {
  test('is exposed in both agent and plan mode (read-only)', () => {
    expect(getToolDefinitions('agent').map((t) => t.function.name)).toContain('read_subagent')
    expect(getToolDefinitions('plan').map((t) => t.function.name)).toContain('read_subagent')
  })

  test('remains available with no workspace open (Assistant tab)', () => {
    const tools = getToolDefinitions('agent', 'all', false, false).map((t) => t.function.name)
    expect(tools).toContain('read_subagent')
  })
})

describe('writeSkill manager guard + scoping', () => {
  let tempRoot: string
  let workspace: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-write-skill-'))
    homeMockState.homeDir = join(tempRoot, 'home')
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
    const raw = await readFile(join(homeMockState.homeDir, '.klenny', 'skills', 'my-global-skill', 'SKILL.md'), 'utf8')
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
    homeMockState.homeDir = join(tempRoot, 'home')
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
    const raw = await readFile(join(homeMockState.homeDir, '.klenny', 'agents', 'bug-hunter.md'), 'utf8')
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

  // Regression test: a custom subagent's authored body (the actual instructions passed to
  // write_subagent) used to be parsed off the markdown file and then discarded — listSubagentTypes
  // only returned the frontmatter fields (name/description/tools/model), so the body never made
  // it anywhere. That meant every custom subagent silently ran with none of its own instructions,
  // degrading into a generic agent that only differed by its tool restriction. See
  // getSubagentType()/runSubagent()/buildSystemPrompt() for the fix: the body must survive
  // scanAgents() and be injected into that run's system prompt.
  test('listSubagentTypes returns the full instruction body below the frontmatter, not just metadata', async () => {
    const { writeSubagentType, listSubagentTypes, getSubagentType } = await import('../src/main/agent/subagents/manager')
    const longBody = 'Step 1: log in.\nStep 2: do the analysis.\n\nDetailed instructions go here.'
    await writeSubagentType('body-carrier', 'global', 'Carries a body', 'all', undefined, longBody)

    const types = await listSubagentTypes()
    const found = types.find((t) => t.name === 'body-carrier')
    expect(found?.body).toBe(longBody)

    const viaGetter = await getSubagentType('body-carrier')
    expect(viaGetter?.body).toBe(longBody)
  })

  test('built-in subagent types have no body (their behavior comes from the generic prompt + tool restriction)', async () => {
    const { getSubagentType } = await import('../src/main/agent/subagents/manager')
    const explore = await getSubagentType('explore')
    expect(explore?.builtIn).toBe(true)
    expect(explore?.body).toBeUndefined()
  })
})

describe('buildSystemPrompt injects a custom subagent\'s body into its own run', () => {
  let tempRoot: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-system-prompt-'))
    homeMockState.homeDir = tempRoot
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('a subagentCtx with a body produces a system prompt containing that body and the agent type name', async () => {
    const { writeSubagentType, getSubagentType } = await import('../src/main/agent/subagents/manager')
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const distinctiveInstruction = 'ONLY-IN-THIS-SUBAGENT: log into LoomIQ with the embedded credentials.'
    await writeSubagentType('loomiq-test-agent', 'global', 'test', 'all', undefined, distinctiveInstruction)
    const typeDef = await getSubagentType('loomiq-test-agent')
    expect(typeDef?.body).toBe(distinctiveInstruction)

    const prompt = await buildSystemPrompt('agent', undefined, {
      allowedTools: 'all',
      agentType: 'loomiq-test-agent',
      body: typeDef?.body
    })

    expect(prompt).toContain(distinctiveInstruction)
    expect(prompt).toContain('loomiq-test-agent')
  })

  test('no subagentCtx (main chat tab) produces a system prompt with no per-subagent body section', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent')
    expect(prompt).not.toContain('You are running as the')
  })

  test('a subagentCtx with no body (built-in subagent type) produces no per-subagent body section', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, { allowedTools: 'all', agentType: 'explore' })
    expect(prompt).not.toContain('You are running as the')
  })

  // Regression coverage for the "Assistant tool schema/prompt leak" fix, updated for the later
  // "global file tools, sandboxed to documentsDirectory" feature: an Assistant tab now DOES get
  // read_file/write_file/edit_file/multi_edit/delete_file/grep/glob offered (see ASSISTANT_TOOLS
  // in shared/types.ts), so the prompt legitimately names them — but it never gets the truly
  // workspace-dependent tools (run_command/read_terminal/codebase_search — see CODING_ONLY_TOOLS),
  // and the prompt must still never name those or the unconditional "Workspace: ..." /
  // "run_command executes via ..." line built from the ambient getWorkspace() singleton —
  // priming the model to attempt calls to tools it was never given schemas for.
  const WORKSPACE_ONLY_TOOL_NAMES = ['run_command', 'read_terminal', 'codebase_search']
  const FILE_TOOL_NAMES = ['read_file', 'write_file', 'edit_file', 'multi_edit', 'delete_file', 'grep', 'glob']

  test('an Assistant-tab system prompt never mentions a workspace-only tool (run_command/read_terminal/codebase_search) by name', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'assistant')
    for (const name of WORKSPACE_ONLY_TOOL_NAMES) {
      expect(prompt).not.toContain(name)
    }
  })

  test('an Assistant-tab system prompt DOES name the file tools, since it now has them (scoped to documentsDirectory)', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'assistant')
    for (const name of FILE_TOOL_NAMES) {
      expect(prompt).toContain(name)
    }
  })

  test('an Assistant-tab system prompt omits the Workspace: / run_command shell-syntax lines', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'assistant')
    expect(prompt).not.toContain('Workspace:')
    expect(prompt).not.toContain('No workspace open.')
    expect(prompt).not.toContain('run_command executes via')
  })

  test('a project-tab (kind omitted/default) system prompt still mentions coding tools and the Workspace line', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent')
    expect(prompt).toContain('read_file')
    expect(prompt).toContain('run_command executes via')
    expect(prompt).toMatch(/Workspace:|No workspace open\./)
  })

  // Regression coverage for the follow-up request: Assistant-tab prompts should read a bit more
  // playful than Agent/Plan mode, and must instruct the model to speak of its own memory (auto-
  // memory notes and the cross-window digest) as lived recollection ("I fetched a ball"), never
  // as an external source being cited ("according to my memory notes...").
  test("an Assistant-tab system prompt instructs speaking of memory as its own recollection, not as a cited source", async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'assistant')
    expect(prompt).toContain('as your own recollection')
    expect(prompt).toContain('I fetched a ball')
    expect(prompt).toContain('according to my memory notes')
  })

  test('an Assistant-tab system prompt reads slightly more playful than the project-tab one', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const assistantPrompt = await buildSystemPrompt('agent', undefined, undefined, 'assistant')
    const projectPrompt = await buildSystemPrompt('agent')
    // The project-tab body opens plainly with "a capable coding agent" and no such framing.
    expect(assistantPrompt).not.toEqual(projectPrompt)
    expect(assistantPrompt).toContain('home base between errands')
    expect(projectPrompt).not.toContain('home base between errands')
  })
})
