// Shared mutable state for the orchestrator, plus the small set of primitives (types, turn-end
// bookkeeping, event broadcast) that don't belong to any single concern. Every Map/Set exported
// below is a process-wide singleton keyed by tabId — do not re-instantiate this module's state
// anywhere else; every orchestrator submodule that needs it must import these exact bindings so
// they all observe the same, single set of live turns/questions/abort-controllers.
import { BrowserWindow } from 'electron'
import type { AgentStreamEvent, PendingQuestion, QuestionAnswer, ToolName } from '@shared/types'

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
  | 'error'

export interface SubagentContext {
  /** tool restriction for this subagent type ('all' = no restriction beyond mode defaults) */
  allowedTools: ToolName[] | 'all'
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
/**
 * Per-tab wire-message index of the "last message" cache breakpoint from the *previous* request
 * for that tab, so the next request can explicitly re-mark that same position in addition to its
 * own new last-message breakpoint — see the long comment on `applyCacheControl` in
 * openrouter/caching.ts for why relying on implicit cross-request lookback alone doesn't get
 * cache hits through OpenRouter in practice, even though it's Anthropic's documented default
 * behavior. Cleared whenever compaction shifts message indices (see loop.ts) since a stale index
 * would then point at different content.
 */
export const lastCacheBreakpointIdx = new Map<string, number>()

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
