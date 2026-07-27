// Assembles the full system prompt for a turn: memory (project/global KLENNY.md, auto-memory
// index), the skills and subagent catalogs, other known projects, the mode-specific (agent vs.
// plan) persona/instructions prompt, and shell context. Called once per agentLoop step.
import { getWorkspace } from '../../workspace'
import { listKnownProjects } from '../../projectsRegistry'
import { resolveShell } from '../../shells'
import { loadProjectMemory, loadGlobalMemory, loadAutoMemoryIndex } from '../memory/manager'
import { listSkills, skillsCatalogPrompt } from '../skills/manager'
import { listSubagentTypes, subagentsCatalog } from '../subagents/manager'
import { buildAgentModePrompt, buildPlanModePrompt } from '../plan/manager'
import { readSoul } from '../soul/manager'
import type { SubagentContext } from './state'

/**
 * The one genuinely per-request-dynamic piece of context the model needs (for computing relative
 * delays/times, e.g. scheduler_create_task's cron `schedule`). Deliberately kept OUT of
 * buildSystemPrompt's return value — it changes on every single call (down to the second), and
 * the whole system message is sent/cached as one prefix. Folding it into that string would mean
 * the "static" system prompt is never actually identical twice, so explicit-cache models
 * (Anthropic, Qwen, ...) would never get a cache hit on it. Callers must send this separately,
 * as an uncached trailing content part appended after the wire messages are built (see
 * `streamChatCompletion`'s `currentTimeNote` option / `applyCacheControl` in openrouter/caching.ts)
 * so the big, truly static prefix (persona, memory, skills/subagent catalogs) can still cache
 * normally. Also note: whichever message this note gets appended to is deliberately never the
 * one `applyCacheControl` cache-marks (that mark instead lands one message earlier) — see its
 * doc comment for why a note-bearing message must never also be a cache breakpoint.
 */
export function buildCurrentTimeNote(): string {
  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `Current date/time: ${now.toString()} (timezone: ${tz}). This is ground truth for "now" — use it directly to compute relative delays or specific future times (e.g. for scheduler_create_task's cron \`schedule\`) instead of looking up the time via the browser tool or any other tool.`
}

export async function buildSystemPrompt(
  mode: 'agent' | 'plan',
  shellId?: string | null,
  subagentCtx?: SubagentContext
): Promise<string> {
  const ws = getWorkspace()
  const [projMem, globalMem, autoMem, skills, subagents, otherProjects, soul] = await Promise.all([
    loadProjectMemory(),
    loadGlobalMemory(),
    loadAutoMemoryIndex(),
    listSkills(),
    listSubagentTypes(),
    listKnownProjects(),
    readSoul()
  ])

  const shell = resolveShell(shellId)

  const parts = [
    mode === 'plan' ? buildPlanModePrompt(soul) : buildAgentModePrompt(soul),
    // A custom subagent's own instructions (the write_subagent-authored body) take priority over
    // — and go right after — the generic persona/rules above: this is what actually makes a
    // custom subagent type behave as authored instead of degrading into a plain general-purpose
    // agent that only differs by its tool restriction. Built-in types (general-purpose/explore/
    // plan-checker) have no body, so this is a no-op for them.
    subagentCtx?.body &&
      `You are running as the "${subagentCtx.agentType}" subagent. These are that subagent type's own operating instructions — follow them as your primary task guidance, in addition to (not instead of) the general rules above:\n\n${subagentCtx.body}`,
    ws ? `Workspace: ${ws}` : 'No workspace open.',
    `run_command executes via ${shell.name} — write commands using that shell's syntax (quoting, path separators, env vars, chaining operators).`,
    projMem && `Project memory:\n${projMem}`,
    globalMem && `Global memory:\n${globalMem}`,
    autoMem && `Auto-memory index:\n${autoMem}`,
    otherProjects.length > 0 &&
      `Other known projects (read-only — use read_other_project_file/grep_other_project/glob_other_project/read_other_project_memory to reference or port things from these; never write to them):\n${otherProjects.map((p) => `- ${p}`).join('\n')}`,
    skillsCatalogPrompt(skills),
    `Subagents:\n${subagentsCatalog(subagents)}`
  ].filter(Boolean)

  return parts.join('\n\n')
}
