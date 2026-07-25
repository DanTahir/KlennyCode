// Public entry points for starting/resuming/stopping a turn on a tab, plus the question-answer
// and pending-question plumbing that ties into the ask_question tool (handled in loop.ts's
// executeTool). Everything here is orchestration around agentLoop (loop.ts), never the model-
// streaming/tool-dispatch logic itself.
import { BrowserWindow, Notification } from 'electron'
import { nanoid } from 'nanoid'
import type { ChatMessage, ContentBlock, PendingQuestion, QuestionAnswer, TabSession } from '@shared/types'
import { getApiKey, loadSettings } from '../../settings'
import { sessionStore } from '../../session/store'
import { disposeSession as disposeBrowserSession } from '../../browser/manager'
import { approvalManager } from '../approval/manager'
import { agentLoop } from './loop'
import { checkSpendCap } from './approval-previews'
import {
  type Emit,
  type LoopStopReason,
  abortControllers,
  questionWaiters,
  pendingQuestions,
  endedTurns,
  activeRuns,
  emitToAll,
  endTurn
} from './state'

export function resolveQuestion(questionId: string, answers: QuestionAnswer[]): void {
  const waiter = questionWaiters.get(questionId)
  if (waiter) {
    waiter(answers)
    questionWaiters.delete(questionId)
  }
  pendingQuestions.delete(questionId)
}

export function stopGeneration(tabId: string): void {
  abortControllers.get(tabId)?.abort()

  for (const [questionId, question] of pendingQuestions) {
    if (question.tabId !== tabId) continue
    resolveQuestion(questionId, [])
    emitToAll({ type: 'pending_question_resolved', tabId, questionId })
  }

  for (const action of approvalManager.getPending(tabId)) {
    emitToAll({ type: 'pending_action_resolved', tabId, actionId: action.id })
  }
  approvalManager.cancelForTab(tabId)

  endTurn(tabId)
}

/** Must be called once a tab is permanently gone (closed) so none of the module-level
 *  per-tab bookkeeping below outlives it. Without this, a tab that's closed while a turn is
 *  in flight (or while a question is pending) leaves its abort controller / ended-turn /
 *  active-run entries in these maps forever, since nothing else ever removes them for a tabId
 *  that no longer exists in the session store — a slow, permanent memory leak in long-running
 *  sessions with many opened/closed tabs. Safe to call for any tabId, including ones with no
 *  in-flight activity.
 *
 *  stopGeneration() already resolves/removes any pending questions and approvals for this tab
 *  as part of aborting it, so this only needs to clean up what stopGeneration itself doesn't:
 *  the abort-controller, ended-turn, and active-run bookkeeping. */
export function clearTabState(tabId: string): void {
  // Abort first so any in-flight agentLoop/streaming for this tab stops touching the (now
  // gone) tab object and its own cleanup in startAgentLoop's finally block gets a chance to run.
  stopGeneration(tabId)

  abortControllers.delete(tabId)
  endedTurns.delete(tabId)
  activeRuns.delete(tabId)

  // Best-effort — don't let a slow/failed browser teardown block tab close. No-op if this tab
  // never used the browser tool (disposeSession() checks the session map first).
  void disposeBrowserSession(tabId).catch(() => {})
}

/** Shared wrapper around agentLoop for both a brand-new user turn and a resumed (post-pause)
 *  turn — centralizes abort-controller bookkeeping and error/turn_end handling so runUserTurn
 *  and continueTurn can't drift out of sync with each other. */
async function startAgentLoop(
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  emit: Emit,
  ac: AbortController
): Promise<void> {
  const signal = ac.signal
  // Only 'natural' (finished normally), 'truncation_failed', and 'error' are genuine end-of-turn
  // states — 'aborted' means a newer turn preempted this one, and 'checkpoint'/'hard_limit' just
  // pause the turn waiting for the user to click "Continue", so none of those warrant a
  // "task finished" notification.
  let stopReason: LoopStopReason | 'thrown' = 'thrown'
  try {
    stopReason = await agentLoop(tab, apiKey, subagentModel, emit, signal)
  } catch (e) {
    if (signal.aborted) {
      stopReason = 'aborted'
    } else {
      stopReason = 'thrown'
      emit({
        type: 'error',
        tabId: tab.id,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  } finally {
    endTurn(tab.id, emit)
    const isRealCompletion = stopReason === 'natural' || stopReason === 'error' || stopReason === 'truncation_failed' || stopReason === 'thrown'
    if (isRealCompletion && !BrowserWindow.getFocusedWindow()) {
      new Notification({ title: 'Klenny Code task finished', body: tab.title }).show()
    }
    // Only clear the bookkeeping if we're still the "current" controller for this tab — a
    // newer call may have already preempted us (see launchAgentLoop) and installed its own
    // controller, in which case clearing here would wrongly wipe its state out from under it.
    if (abortControllers.get(tab.id) === ac) {
      abortControllers.delete(tab.id)
      endedTurns.delete(tab.id)
    }
  }
}

/** Entry point every new/resumed turn on a tab must go through. If a previous turn on this tab
 *  is still running, aborts it immediately and waits for it to fully unwind (so it stops
 *  mutating tab.messages / calling the model) before running `beforeStart` (append the new user
 *  message, etc.) and starting the new loop — this is what prevents two agentLoop invocations for
 *  the same tab from ever running concurrently, even if the caller fires a new turn before the
 *  previous one's `message_start` event has round-tripped to the renderer.
 *
 *  Because this is re-entrant (a third call can preempt the second while it's still waiting on
 *  the first), `beforeStart` always runs — every message the user actually sent gets recorded, in
 *  order — but the loop itself is skipped if a *newer* call has since taken over (no point
 *  starting a generation immediately superseded by another already-queued message). */
async function launchAgentLoop(
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  emit: Emit,
  beforeStart?: () => Promise<void> | void
): Promise<void> {
  const previousRun = activeRuns.get(tab.id)
  abortControllers.get(tab.id)?.abort()

  const ac = new AbortController()
  abortControllers.set(tab.id, ac)
  endedTurns.delete(tab.id)

  const run = (async () => {
    if (previousRun) await previousRun.catch(() => undefined)
    await beforeStart?.()
    // If another call has since replaced our controller while we were waiting, bail out
    // without starting a (redundant, immediately-superseded) generation.
    if (abortControllers.get(tab.id) !== ac) return
    await startAgentLoop(tab, apiKey, subagentModel, emit, ac)
  })()
  activeRuns.set(tab.id, run)
  try {
    await run
  } finally {
    if (activeRuns.get(tab.id) === run) activeRuns.delete(tab.id)
  }
}

export async function runUserTurn(tabId: string, userText: string, images?: string[]): Promise<void> {
  const tab = sessionStore.getTab(tabId)
  if (!tab) return

  const apiKey = await getApiKey()
  if (!apiKey) {
    emitToAll({ type: 'error', tabId, message: 'OpenRouter API key not set.' })
    return
  }

  const settings = await loadSettings()
  checkSpendCap(tab, settings.spendingCapUsd, settings.spendingCapPeriod)

  await launchAgentLoop(tab, apiKey, settings.subagentModel, emitToAll, async () => {
    const userBlocks: ContentBlock[] = [{ type: 'text', text: userText }]
    if (images?.length) {
      for (const img of images) userBlocks.push({ type: 'image', dataUrl: img })
    }
    const userMsg: ChatMessage = { id: nanoid(), role: 'user', blocks: userBlocks, createdAt: Date.now() }
    tab.messages.push(userMsg)
    // Assistant tabs start life titled 'Assistant' (see SessionStore.createAssistantTab)
    // instead of 'Code chat' — rename on the first real user message either way, so Assistant
    // tabs get a meaningful title too instead of staying generic forever.
    const isDefaultTitle = tab.title === 'Code chat' || tab.title === 'Assistant'
    const titleChanged = isDefaultTitle && userText.trim().length > 0
    if (titleChanged) tab.title = userText.trim().slice(0, 40)
    await sessionStore.updateTab(tab)
    emitToAll({ type: 'user_message', tabId, message: userMsg })
    // The 'user_message' event above only carries the new message, not the tab itself, so a
    // freshly-renamed tab title never reaches the renderer's tab list until some other event
    // happens to refresh it. Broadcast the updated tab so the title change shows up immediately.
    if (titleChanged) emitToAll({ type: 'tab_upserted', tab })
  })
}

/** Resumes a turn that emitted `turn_paused` (checkpoint step count reached, or the hard safety
 *  ceiling was hit) — continues agentLoop from the existing message state with a fresh step
 *  budget. No new user-message bubble is created. */
export async function continueTurn(tabId: string): Promise<void> {
  const tab = sessionStore.getTab(tabId)
  if (!tab) return

  const apiKey = await getApiKey()
  if (!apiKey) {
    emitToAll({ type: 'error', tabId, message: 'OpenRouter API key not set.' })
    return
  }

  const settings = await loadSettings()
  checkSpendCap(tab, settings.spendingCapUsd, settings.spendingCapPeriod)

  await launchAgentLoop(tab, apiKey, settings.subagentModel, emitToAll)
}

export function getPendingQuestions(): PendingQuestion[] {
  return [...pendingQuestions.values()]
}
