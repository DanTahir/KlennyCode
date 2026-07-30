// Assembles the full system prompt for a turn: memory (project/global KLENNY.md, auto-memory
// index), the skills and subagent catalogs, other known projects, the mode-specific (agent vs.
// plan) persona/instructions prompt, and shell context. Called once per agentLoop step.
import { getWorkspace } from '../../workspace'
import { listKnownProjects } from '../../projectsRegistry'
import { resolveShell } from '../../shells'
import { loadProjectMemory, loadGlobalMemory, loadAutoMemoryIndex } from '../memory/manager'
import { listSkills, skillsCatalogPrompt } from '../skills/manager'
import { listSubagentTypes, subagentsCatalog } from '../subagents/manager'
import { buildAgentModePrompt, buildPlanModePrompt, type AssistantToolAvailability } from '../plan/manager'
import { readSoul } from '../soul/manager'
import { buildAssistantMemoryDigestForTab } from '../memory/assistantMemory'
import type { SubagentContext } from './state'
import type { ChecklistItem } from '@shared/types'

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
 *
 * `assistantTabId`, when given, folds the shared Assistant-memory digest (see
 * assistantMemory.ts) into this same uncached trailing note rather than a separate one — the
 * digest is pool-wide state that can change on *any* Assistant tab's turn, not just this one, so
 * it must live in the same never-cached tail slot described above. Excludes `assistantTabId`'s
 * own slot so a tab never "reads back" its own last update as if it were another window's
 * activity.
 *
 * `activeChecklist`, when given, folds the tab's live plan-progress checklist (see
 * TabSession.activeChecklist) into this same uncached trailing note. It has to live here rather
 * than in the cached system-prompt prefix for the same reason as the digest above: it mutates on
 * every update_checklist call within a turn, so baking it into the "static" prefix would defeat
 * prompt caching on every single call. It's also re-derived fresh from `activeChecklist` every
 * turn rather than relied upon via chat history, so the model always has an accurate done/
 * not-done view even once context compaction has folded away the ChatMessage that first
 * displayed it (see the compaction gotcha this avoids in TabSession.activeChecklist's doc
 * comment).
 */
export async function buildCurrentTimeNote(
  assistantTabId?: string,
  activeChecklist?: { title: string; items: ChecklistItem[] }
): Promise<string> {
  const now = new Date()
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  let timeNote = `Current date/time: ${now.toString()} (timezone: ${tz}). This is ground truth for "now" — use it directly to compute relative delays or specific future times (e.g. for scheduler_create_task's cron \`schedule\`) instead of looking up the time via the browser tool or any other tool.`
  if (activeChecklist && activeChecklist.items.length > 0) {
    const lines = activeChecklist.items.map((it, i) => `${i + 1}. [${it.done ? 'x' : ' '}] ${it.text}`)
    timeNote += `\n\nCurrent plan checklist ("${activeChecklist.title}") — call update_checklist (by 1-based index) as you actually finish each item, not all at once at the end; make one final update_checklist call once everything is done, right before your closing summary:\n${lines.join('\n')}`
  }
  if (!assistantTabId) return timeNote
  const digest = await buildAssistantMemoryDigestForTab(assistantTabId)
  // Framed as recollection ("Recently, in your other Assistant windows"), not as a labeled
  // document/log — see ASSISTANT_MODE_PROMPT_BODY's instruction to talk about this as its own
  // memory (e.g. "I fetched a ball") rather than citing it ("according to my memory notes...").
  return digest ? `${timeNote}\n\nRecently, in your other Assistant windows:\n${digest}` : timeNote
}

export async function buildSystemPrompt(
  mode: 'agent' | 'plan',
  shellId?: string | null,
  subagentCtx?: SubagentContext,
  /** 'assistant' for the ephemeral Assistant tab (and any subagent spawned from one — see
   *  loop.ts's kind inheritance). Selects the Assistant-specific persona/instructions body
   *  (no mention of file/shell tools it doesn't have — see buildAgentModePrompt) and skips the
   *  Workspace/shell-syntax lines below, which are meaningless without a real project open and
   *  would otherwise leak the ambient getWorkspace() singleton's project path/shell into an
   *  Assistant tab that has no workspace of its own. See "Assistant tool schema/prompt leak"
   *  investigation. */
  kind: 'project' | 'assistant' = 'project',
  /** Only meaningful when kind === 'assistant' — see AssistantToolAvailability's doc comment.
   *  Computed by the caller (loop.ts) from the same settings passed to getToolDefinitions()'s
   *  gating option, so the prompt text and the actual tool schema always agree on what's
   *  available. Omitted entirely for project-kind tabs/plan mode, where the prompt never names
   *  these tools by name regardless. */
  assistantTools?: AssistantToolAvailability
): Promise<string> {
  const isAssistant = kind === 'assistant'
  const ws = isAssistant ? null : getWorkspace()
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
    mode === 'plan' ? buildPlanModePrompt(soul) : buildAgentModePrompt(soul, kind, assistantTools),
    // A custom subagent's own instructions (the write_subagent-authored body) take priority over
    // — and go right after — the generic persona/rules above: this is what actually makes a
    // custom subagent type behave as authored instead of degrading into a plain general-purpose
    // agent that only differs by its tool restriction. Built-in types (general-purpose/explore/
    // plan-checker) have no body, so this is a no-op for them.
    subagentCtx?.body &&
      `You are running as the "${subagentCtx.agentType}" subagent. These are that subagent type's own operating instructions — follow them as your primary task guidance, in addition to (not instead of) the general rules above:\n\n${subagentCtx.body}`,
    !isAssistant && (ws ? `Workspace: ${ws}` : 'No workspace open.'),
    !isAssistant &&
      `run_command executes via ${shell.name} — write commands using that shell's syntax (quoting, path separators, env vars, chaining operators).`,
    projMem && `Project memory:\n${projMem}`,
    globalMem && `Global memory:\n${globalMem}`,
    autoMem && `Auto-memory index:\n${autoMem}`,
    otherProjects.length > 0 &&
      `Other known projects (read-only — use read_file/grep/glob with an absolute path into one of these to reference or port things from it, or read_memory/list_memory with \`project\` set to its path to look at its memory notes; never write to them):\n${otherProjects.map((p) => `- ${p}`).join('\n')}`,
    skillsCatalogPrompt(skills),
    `Subagents:\n${subagentsCatalog(subagents)}`
  ].filter(Boolean)

  return parts.join('\n\n')
}
