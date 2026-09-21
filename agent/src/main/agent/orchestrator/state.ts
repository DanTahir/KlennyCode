// Shared mutable state for the orchestrator, plus the small set of primitives (types, turn-end
// bookkeeping, event broadcast) that don't belong to any single concern. Every Map/Set exported
// below is a process-wide singleton keyed by tabId — do not re-instantiate this module's state
// anywhere else; every orchestrator submodule that needs it must import these exact bindings so
// they all observe the same, single set of live turns/questions/abort-controllers.
import { BrowserWindow } from 'electron'
import type { AgentStreamEvent, PendingQuestion, QuestionAnswer, ToolName } from '@shared/types'
import type { SystemPromptSnapshot } from './prompt-snapshot'

export type Emit = (event: AgentStreamEvent) => void

/** Why a single call to agentLoop stopped recursing. Used by callers (runSubagent, tests) to
 *  distinguish a genuinely finished task from one that stopped early for some other reason —
 *  every one of these (besides 'natural') used to be an indistinguishable silent `return`. */
export type LoopStopReason =
  | 'natural'
  | 'aborted'
  | 'checkpoint'
  | 'hard_limit'
  | 'subagent_budget'
  | 'truncation_failed'
  /** The fabrication guard found hard contradictions and the model failed to produce a clean,
   *  non-contradicted correction within the allowed retries. Treated like 'checkpoint' rather
   *  than a real completion — the task demonstrably did not finish. */
  | 'audit_failed'
  | 'error'

export interface SubagentContext {
  /** tool restriction for this subagent type ('all' = no restriction beyond mode defaults) */
  allowedTools: ToolName[] | 'all'
  /** name of the running subagent type, for the system prompt's own reference (e.g. so it can
   *  say "you are running as the X subagent") */
  agentType?: string
  /** the custom subagent type's own SKILL.md-style instructions (markdown body below the
   *  frontmatter), injected into this run's system prompt so custom subagents (created via
   *  write_subagent) actually behave as authored instead of falling back to the generic
   *  agent-mode prompt. Undefined for built-in subagent types (general-purpose/explore/
   *  plan-checker), which intentionally have no body — their behavior comes from the generic
   *  prompt plus their tool restriction. */
  body?: string
}

export const abortControllers = new Map<string, AbortController>()
export const questionWaiters = new Map<string, (answers: QuestionAnswer[]) => void>()
export const pendingQuestions = new Map<string, PendingQuestion>()
export const endedTurns = new Set<string>()
/** Tracks the in-flight startAgentLoop promise per tab so a new turn (runUserTurn/continueTurn)
 *  can wait for any previous turn on the same tab to fully unwind before touching tab.messages
 *  or starting its own loop — otherwise two agentLoop invocations for the same tab could run
 *  concurrently (e.g. user sends a second message before the first turn's abort is even wired
 *  up), both mutating tab.messages and both calling the model API at the same time. */
export const activeRuns = new Map<string, Promise<void>>()
/** The frozen system-prompt prefix per conversation. Deliberately module state here rather than a
 *  field on TabSession: TabSession is persisted to disk and shipped over IPC on every update, so
 *  parking a ~80 KB prompt string in it would bloat every session file and every renderer payload
 *  (see the binary-diff session-log incident for what oversized persisted payloads cost). This is
 *  pure cache — losing it on restart just means the next turn rebuilds the prompt once, which is
 *  correct behavior for a new conversation anyway. See prompt-snapshot.ts for the why. */
export const systemPromptSnapshots = new Map<string, SystemPromptSnapshot>()

/** Bound on tracked conversations. clearTabState() removes a real tab's entry on close, but
 *  subagent runs synthesize their own ephemeral tab ids that nothing ever closes, so without a cap
 *  this map would grow for the life of the process. */
const MAX_TRACKED_PROMPT_SNAPSHOTS = 200

/** Store a conversation's frozen prompt, evicting wholesale if the map has grown past its cap.
 *  A full clear (rather than LRU eviction) is deliberate: the cost of a miss is one rebuilt prompt
 *  on the next step of each affected conversation, so precision here buys nothing worth the
 *  bookkeeping — and at 200 live conversations the process has bigger problems. */
export function rememberSystemPromptSnapshot(tabId: string, snapshot: SystemPromptSnapshot): void {
  if (!systemPromptSnapshots.has(tabId) && systemPromptSnapshots.size >= MAX_TRACKED_PROMPT_SNAPSHOTS) {
    systemPromptSnapshots.clear()
  }
  systemPromptSnapshots.set(tabId, snapshot)
}

export function emitToAll(event: AgentStreamEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream', event)
  }
}

export function endTurn(tabId: string, emit: Emit = emitToAll): void {
  if (endedTurns.has(tabId)) return
  endedTurns.add(tabId)
  emit({ type: 'turn_end', tabId })
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}
