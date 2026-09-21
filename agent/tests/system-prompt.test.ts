import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect the global Klenny dir (~/.klenny) to an isolated temp "home" so this test never
// touches the real user home directory — see testHomeMock.ts for why the shared mock (not a
// locally-declared one) must be used.
import { homeMockState } from './testHomeMock'
// Shared electron mock — system-prompt.ts transitively imports electron (via workspace.ts,
// settings.ts, projectsRegistry.ts) — must be registered before those modules are first loaded.
import { electronMockState } from './testElectronMock'

let userDataDir: string
let fakeHome: string
let workspaceDir: string
let otherProjectDir: string

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'klenny-sysprompt-userdata-'))
  fakeHome = await mkdtemp(join(tmpdir(), 'klenny-sysprompt-home-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-sysprompt-ws-'))
  otherProjectDir = await mkdtemp(join(tmpdir(), 'klenny-sysprompt-other-'))

  electronMockState.userDataDir = userDataDir
  homeMockState.homeDir = fakeHome

  // Project memory (KLENNY.md at the workspace root).
  await writeFile(join(workspaceDir, 'KLENNY.md'), '# Project Memory\nThis project is a widget factory.\n', 'utf8')

  // Auto-memory index for the workspace, under <userData>/projects/<id>/memory/MEMORY.md.
  const wsId = Buffer.from(workspaceDir).toString('base64url')
  await mkdir(join(userDataDir, 'projects', wsId, 'memory'), { recursive: true })
  await writeFile(
    join(userDataDir, 'projects', wsId, 'memory', 'MEMORY.md'),
    '# Memory Index\n- [Widget rendering](Widget rendering.md) — Notes on the widget renderer.\n',
    'utf8'
  )

  // Global memory (~/.klenny/KLENNY.md).
  await mkdir(join(fakeHome, '.klenny'), { recursive: true })
  await writeFile(join(fakeHome, '.klenny', 'KLENNY.md'), '# Global Memory\nUser prefers dark mode.\n', 'utf8')

  // Custom soul (persona) content, so we can assert it flows through verbatim.
  await writeFile(join(fakeHome, '.klenny', 'SOUL.md'), 'I am a test persona named Zippy.\n', 'utf8')

  // A project-scoped skill and a global-scoped skill.
  await mkdir(join(workspaceDir, '.klenny', 'skills', 'project-skill'), { recursive: true })
  await writeFile(
    join(workspaceDir, '.klenny', 'skills', 'project-skill', 'SKILL.md'),
    '---\nname: project-skill\ndescription: A project-scoped test skill\n---\n\nBody\n',
    'utf8'
  )
  await mkdir(join(fakeHome, '.klenny', 'skills', 'global-skill'), { recursive: true })
  await writeFile(
    join(fakeHome, '.klenny', 'skills', 'global-skill', 'SKILL.md'),
    '---\nname: global-skill\ndescription: A global test skill\n---\n\nBody\n',
    'utf8'
  )

  // A custom global subagent type with its own body.
  await mkdir(join(fakeHome, '.klenny', 'agents'), { recursive: true })
  await writeFile(
    join(fakeHome, '.klenny', 'agents', 'custom-agent.md'),
    '---\nname: custom-agent\ndescription: A custom test subagent\ntools: [read_file]\n---\n\nCustom agent instructions body.\n',
    'utf8'
  )

  // Register another known project (must exist on disk + have a userData entry to be listed).
  const otherId = Buffer.from(otherProjectDir).toString('base64url')
  await mkdir(join(userDataDir, 'projects', otherId, 'memory'), { recursive: true })

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(userDataDir, { recursive: true, force: true })
  await rm(fakeHome, { recursive: true, force: true })
  await rm(workspaceDir, { recursive: true, force: true })
  await rm(otherProjectDir, { recursive: true, force: true })
})

describe('buildSystemPrompt — project kind, agent mode', () => {
  test('includes workspace path, shell instructions, project/global memory, auto-memory index, other projects, skills, subagents, and persona', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')

    // Agent-mode persona body (from plan/manager.ts's AGENT_MODE_PROMPT_BODY).
    expect(prompt).toContain('You are Klenny, a capable coding agent')

    // Workspace + shell.
    expect(prompt).toContain(`Workspace: ${workspaceDir}`)
    expect(prompt).toMatch(/run_command executes via/)

    // Project + global memory + auto-memory index.
    expect(prompt).toContain('Project memory:')
    expect(prompt).toContain('This project is a widget factory.')
    expect(prompt).toContain('Global memory:')
    expect(prompt).toContain('User prefers dark mode.')
    expect(prompt).toContain('Auto-memory index:')
    expect(prompt).toContain('Widget rendering')

    // Other known projects.
    expect(prompt).toContain('Other known projects')
    expect(prompt.replace(/\\/g, '/').toLowerCase()).toContain(otherProjectDir.replace(/\\/g, '/').toLowerCase())

    // Skills catalog — both project- and global-scoped skills present.
    expect(prompt).toContain('Available skills')
    expect(prompt).toContain('project-skill')
    expect(prompt).toContain('global-skill')

    // Subagents catalog — built-ins plus the custom global one.
    expect(prompt).toContain('Subagents:')
    expect(prompt).toContain('general-purpose')
    expect(prompt).toContain('explore')
    expect(prompt).toContain('plan-checker')
    expect(prompt).toContain('custom-agent')

    // Persona/soul content plus the non-editable guardrails appended after it.
    expect(prompt).toContain('I am a test persona named Zippy.')
    expect(prompt).toContain('Personality guardrails')

    // Shared cross-mode guardrail notes.
    expect(prompt).toContain('Truthful narration')
    expect(prompt).toContain('Checklist honesty')
    expect(prompt).toContain('System-message structure')
  })

  test('sections are separated by a blank line', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')
    // Workspace/memory/skills/subagents sections are distinct `parts` joined with '\n\n' — assert
    // that separator actually shows up between two known-adjacent sections, rather than them
    // being run together or duplicated.
    expect(prompt).toContain('Global memory:\n# Global Memory\nUser prefers dark mode.\n\n\nAuto-memory index:')
    expect(prompt).toContain('- global-skill (global): A global test skill\n\nSubagents:')
  })
})

describe('buildSystemPrompt — no workspace open', () => {
  test('reports "No workspace open." and omits workspace-scoped sections, but keeps global memory', async () => {
    const { setWorkspace } = await import('../src/main/workspace')
    setWorkspace(null)
    try {
      const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
      const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')

      expect(prompt).toContain('No workspace open.')
      expect(prompt).not.toContain('Project memory:')
      expect(prompt).not.toContain('Auto-memory index:')
      // Global memory has no workspace dependency, so it should still show up.
      expect(prompt).toContain('Global memory:')
      expect(prompt).toContain('User prefers dark mode.')
      // Project-scoped skill/subagent (workspace-dependent) should disappear; global ones remain.
      expect(prompt).not.toContain('project-skill')
      expect(prompt).toContain('global-skill')
    } finally {
      setWorkspace(workspaceDir)
    }
  })
})

describe('buildSystemPrompt — plan mode', () => {
  test('uses the PLAN MODE body instead of the agent-mode body, but keeps shared guardrails', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('plan', undefined, undefined, 'project')

    expect(prompt).toContain('You are in PLAN MODE')
    expect(prompt).not.toContain('You are Klenny, a capable coding agent')
    expect(prompt).toContain('save_plan')
    // Shared notes still present in plan mode.
    expect(prompt).toContain('Truthful narration')
    expect(prompt).toContain('Checklist honesty')
    expect(prompt).toContain('I am a test persona named Zippy.')
  })
})

describe('buildSystemPrompt — assistant kind', () => {
  test('omits workspace/shell lines and uses the Assistant persona body', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'assistant', {
      docx: false,
      gmailRead: false,
      gmailSend: false,
      discord: false,
      browser: false
    })

    expect(prompt).not.toContain('Workspace:')
    expect(prompt).not.toContain('run_command executes via')
    expect(prompt).toContain('personal assistant')
    // Base file-tool clause always present.
    expect(prompt).toContain('read_file/write_file/edit_file/multi_edit/multi_write/delete_file/grep/glob')
    // Option-gated tools not mentioned when unavailable.
    expect(prompt).not.toContain('read_docx/write_docx/edit_docx')
    expect(prompt).not.toContain('gmail_list_messages')
    expect(prompt).not.toContain('discord_post_message')
    expect(prompt).not.toContain('driving a local browser')
  })

  test('names docx/Gmail/Discord/browser tools only when the corresponding flag is true', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'assistant', {
      docx: true,
      gmailRead: true,
      gmailSend: true,
      discord: true,
      browser: true
    })

    expect(prompt).toContain('read_docx/write_docx/edit_docx')
    expect(prompt).toContain('gmail_list_messages')
    expect(prompt).toContain('gmail_send_message')
    expect(prompt).toContain('discord_post_message')
    expect(prompt).toContain('driving a local browser')
  })

  test('defaults to no option-gated tools when assistantTools is omitted', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'assistant')
    expect(prompt).not.toContain('read_docx/write_docx/edit_docx')
    expect(prompt).not.toContain('gmail_list_messages')
  })
})

describe('buildSystemPrompt — subagentCtx body injection', () => {
  test('injects a custom subagent body with an explanatory wrapper', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, { allowedTools: 'all', agentType: 'custom-agent', body: 'Follow these special steps.' }, 'project')

    expect(prompt).toContain('You are running as the "custom-agent" subagent')
    expect(prompt).toContain('Follow these special steps.')
  })

  test('omits the subagent-body block when subagentCtx has no body (built-in types)', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, { allowedTools: 'all', agentType: 'general-purpose' }, 'project')
    expect(prompt).not.toContain('You are running as the')
  })

  test('omits the subagent-body block entirely when no subagentCtx is passed', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(prompt).not.toContain('You are running as the')
  })
})

describe('buildCurrentTimeNote — verification ledger digest (cache-safety critical)', () => {
  test('renders the ledger digest in the trailing note when one is supplied', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const { buildLedgerDigest, buildTurnLedger } = await import('../src/main/agent/orchestrator/ledger')
    const digest = buildLedgerDigest(
      buildTurnLedger([
        { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'go' }], createdAt: Date.now() },
        {
          id: 'a1',
          role: 'assistant',
          blocks: [{ type: 'tool_call', id: 'tc1', toolName: 'read_file', args: { path: 'a.ts' }, status: 'success' }],
          createdAt: Date.now()
        }
      ] as never)
    )
    const note = await buildCurrentTimeNote(undefined, undefined, undefined, digest)
    expect(note).toContain('Tool calls actually made so far this turn')
    expect(note).toContain('read_file')
    // Still carries the clock: the ledger is additive to the trailing note, not a replacement.
    expect(note).toContain('Current date/time:')
  })

  test('omits the ledger section entirely when no digest is supplied', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote()
    expect(note).not.toContain('Tool calls actually made so far this turn')
    expect(note).toContain('Current date/time:')
  })

  test('the ledger digest never leaks into the CACHED system-prompt prefix', async () => {
    // The whole reason the digest lives in buildCurrentTimeNote's trailing slot: it changes on
    // every request within a turn. If it ever appears in buildSystemPrompt()'s output, the
    // "static" cached prefix stops being byte-identical between calls and prefix cache hits die.
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(prompt).not.toContain('Tool calls actually made so far this turn')
    // Two consecutive builds must be byte-identical (nothing per-turn/dynamic baked in).
    const again = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(again).toBe(prompt)
  })

  test('the prompt still explains the ledger mechanism (deterrence) even though the data itself is trailing', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(prompt.toLowerCase()).toContain('verification ledger')
  })
})

describe('buildCurrentTimeNote — turn-scoped batching nudge (cache-safety critical)', () => {
  test('appears at the very END of the trailing note, after the clock', async () => {
    // Placement is the point: this is the last text the model reads before generating, which is
    // where a short behavioral nudge actually lands. If it drifts earlier (or into the cached
    // prefix), it loses the recency that makes it work at all.
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote()
    expect(note).toContain('first privately list what you need next')
    expect(note.trimEnd().endsWith('not one per turn.')).toBe(true)
    expect(note).toContain('Current date/time:')
  })

  test('stays last even when a ledger digest and a checklist precede it', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote(
      undefined,
      { title: 'Some task', items: [{ text: 'step one', done: false }] as never },
      undefined,
      'Tool calls actually made so far this turn: read_file'
    )
    const nudgeIdx = note.indexOf('first privately list what you need next')
    expect(nudgeIdx).toBeGreaterThan(-1)
    expect(nudgeIdx).toBeGreaterThan(note.indexOf('Current live checklist'))
    expect(nudgeIdx).toBeGreaterThan(note.indexOf('Tool calls actually made'))
  })

  test('never leaks into the CACHED system-prompt prefix', async () => {
    // Same invariant as the ledger digest: the trailing note is the deliberately uncached slot.
    // The prefix keeps its own (longer) batching instruction; this short nudge must not appear
    // there, and the prefix must stay byte-identical across builds.
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(prompt).not.toContain('first privately list what you need next')
    const again = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(again).toBe(prompt)
  })
})

describe('system prompt — parallel tool-call instruction strength', () => {
  test('agent mode tells the model to maximize parallel calls, without a general serialize escape hatch', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(prompt).toContain('invoke all relevant tools simultaneously rather than sequentially')
    expect(prompt).toContain('maximizing parallel tool calls')
    // The old wording invited serialization as a co-equal option ("Only serialize when...").
    // The replacement narrows it to a single genuine-dependency exception.
    expect(prompt).not.toContain('Only serialize when')
  })

  test('plan mode carries the same strengthened instruction for read-only tools', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('plan', undefined, undefined, 'project')
    expect(prompt).toContain('invoke all relevant tools simultaneously rather than sequentially')
    expect(prompt).not.toContain('Only serialize when')
  })
})

describe('buildSystemPrompt — shell selection', () => {
  test('names the resolved shell (falls back to the platform default when shellId is invalid/omitted)', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const { resolveShell } = await import('../src/main/shells')
    const expectedShell = resolveShell(undefined)
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(prompt).toContain(`run_command executes via ${expectedShell.name}`)
  })
})

// The system prefix is frozen per conversation (prompt-snapshot.ts) so a write_memory/write_skill
// call can't change the cached system message mid-conversation. The freshness signal that replaces
// the rebuild must therefore live in the trailing note — if it ever lands in the prefix instead, it
// would itself become the churn it exists to avoid.
describe('buildCurrentTimeNote — frozen-prefix staleness note (cache-safety critical)', () => {
  const STALE_MARKER = 'is a snapshot taken when this conversation started'

  test('is omitted entirely when the frozen prefix still matches disk', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote(undefined, undefined, undefined, undefined, false)
    expect(note).not.toContain(STALE_MARKER)
    expect(note).toContain('Current date/time:')
  })

  test('appears when on-disk memory/skills content has drifted from the snapshot', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote(undefined, undefined, undefined, undefined, true)
    expect(note).toContain(STALE_MARKER)
    // Must tell the model how to get current state, or it may conclude a note it just wrote
    // silently failed because the catalog doesn't list it.
    expect(note).toContain('read_memory')
  })

  test('does not displace the batching nudge from the very end of the note', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote(
      undefined,
      { title: 'Some task', items: [{ text: 'step one', done: false }] as never },
      undefined,
      'Tool calls actually made so far this turn: read_file',
      true
    )
    expect(note.trimEnd().endsWith('not one per turn.')).toBe(true)
    const staleIdx = note.indexOf(STALE_MARKER)
    expect(staleIdx).toBeGreaterThan(note.indexOf('Current live checklist'))
    expect(staleIdx).toBeLessThan(note.indexOf('first privately list what you need next'))
  })

  test('never leaks into the CACHED system-prompt prefix', async () => {
    const { buildSystemPrompt } = await import('../src/main/agent/orchestrator/system-prompt')
    const prompt = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(prompt).not.toContain(STALE_MARKER)
    const again = await buildSystemPrompt('agent', undefined, undefined, 'project')
    expect(again).toBe(prompt)
  })
})
