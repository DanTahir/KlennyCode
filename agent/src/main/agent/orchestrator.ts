import { BrowserWindow, Notification } from 'electron'
import { nanoid } from 'nanoid'
import type {
  AgentStreamEvent,
  ChatMessage,
  ContentBlock,
  ModelInfo,
  PendingActionKind,
  PendingQuestion,
  QuestionAnswer,
  SubagentRun,
  TabSession,
  ToolCallBlock,
  ToolName,
  ToolResultPayload
} from '@shared/types'
import { getApiKey, loadSettings } from '../settings'
import { getWorkspace, setWorkspace } from '../workspace'
import { listKnownProjects } from '../projectsRegistry'
import { resolveShell } from '../shells'
import { sessionStore } from '../session/store'
import { streamChatCompletion, fetchModels, type ToolCall } from '../openrouter/client'
import { modelSupportsCaching, computeCacheSavings } from '../openrouter/caching'
import { getToolDefinitions } from './tools/definitions'
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  deleteFileTool,
  grepTool,
  globTool,
  runCommandTool,
  webSearchTool,
  fetchUrlTool,
  resolveWorkspacePath
} from './tools/index'
import {
  listProjectsTool,
  readOtherProjectFileTool,
  grepOtherProjectTool,
  globOtherProjectTool,
  readOtherProjectMemoryTool
} from './tools/otherProjects'
import { readFile } from 'node:fs/promises'
import { toLf } from './tools/eol'
import { loadProjectMemory, loadGlobalMemory, loadAutoMemoryIndex, writeMemory, readMemoryTopic } from './memory/manager'
import { listSkills, readSkill, skillsCatalogPrompt } from './skills/manager'
import { listSubagentTypes, getSubagentType, subagentsCatalog } from './subagents/manager'
import { savePlan, AGENT_MODE_PROMPT, PLAN_MODE_PROMPT } from './plan/manager'
import { approvalManager } from './approval/manager'
import { maybeCompact } from './compaction/compactor'
import { makeDiff } from './tools/diff'
import { resolveEditMatch } from './tools/edit-match'
import { resolveReasoningEffort } from './reasoning'
import { toORMessages } from './messages'
import { trackDailySpend, getDailySpend } from './spend'
import { recordUsage } from './costReport'
import { isIndexActive, searchCode } from './codeindex/manager'
import { gmailListMessagesTool, gmailGetMessageTool, gmailSendMessageTool } from '../integrations/gmail'
import { discordPostMessageTool } from '../integrations/discord'
import { scheduledTaskManager } from '../scheduler/manager'
import {
  MAX_SUBAGENT_DEPTH,
  MAX_TRUNCATION_RETRIES,
  DEFAULT_MAX_COMPLETION_TOKENS,
  checkStepLimit,
  isSubagentBudgetExceeded,
  isTruncatedEmpty,
  isTruncatedToolCallJson,
  truncateSummary
} from './turnControl'

type Emit = (event: AgentStreamEvent) => void

/** Why a single call to agentLoop stopped recursing. Used by callers (runSubagent, tests) to
 *  distinguish a genuinely finished task from one that stopped early for some other reason —
 *  every one of these (besides 'natural') used to be an indistinguishable silent `return`. */
type LoopStopReason =
  | 'natural'
  | 'aborted'
  | 'checkpoint'
  | 'hard_limit'
  | 'subagent_budget'
  | 'truncation_failed'
  | 'error'

const abortControllers = new Map<string, AbortController>()
const questionWaiters = new Map<string, (answers: QuestionAnswer[]) => void>()
const pendingQuestions = new Map<string, PendingQuestion>()
const endedTurns = new Set<string>()
/** Tracks the in-flight startAgentLoop promise per tab so a new turn (runUserTurn/continueTurn)
 *  can wait for any previous turn on the same tab to fully unwind before touching tab.messages
 *  or starting its own loop — otherwise two agentLoop invocations for the same tab could run
 *  concurrently (e.g. user sends a second message before the first turn's abort is even wired
 *  up), both mutating tab.messages and both calling the model API at the same time. */
const activeRuns = new Map<string, Promise<void>>()

function endTurn(tabId: string, emit: Emit = emitToAll): void {
  if (endedTurns.has(tabId)) return
  endedTurns.add(tabId)
  emit({ type: 'turn_end', tabId })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

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
}

function emitToAll(event: AgentStreamEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('agent:stream', event)
  }
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
  try {
    await agentLoop(tab, apiKey, subagentModel, emit, signal)
  } catch (e) {
    if (!signal.aborted) {
      emit({
        type: 'error',
        tabId: tab.id,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  } finally {
    endTurn(tab.id, emit)
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
    if (tab.title === 'New chat') tab.title = userText.slice(0, 40)
    await sessionStore.updateTab(tab)
    emitToAll({ type: 'user_message', tabId, message: userMsg })
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

interface SubagentContext {
  /** tool restriction for this subagent type ('all' = no restriction beyond mode defaults) */
  allowedTools: ToolName[] | 'all'
}

async function agentLoop(
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  emit: Emit,
  signal: AbortSignal,
  subagentDepth = 0,
  subagentCtx?: SubagentContext,
  stepCount = 0,
  truncationRetries = 0
): Promise<LoopStopReason> {
  // Defensive nesting guard only — in practice subagentDepth can only be 0 or 1 since the
  // `task` tool is filtered out once already inside a subagent context (see the tools filter
  // below). This exists purely to fail loudly if that invariant is ever broken, not to bound
  // normal turn length (see stepCount/checkStepLimit for that).
  if (subagentDepth > MAX_SUBAGENT_DEPTH) {
    emit({ type: 'error', tabId: tab.id, message: 'Subagent nesting limit exceeded.' })
    return 'error'
  }
  throwIfAborted(signal)

  const settings = await loadSettings()

  // Bound how long a single turn is allowed to run before pausing/stopping. Subagents have no
  // UI to click "Continue" from, so they always enforce their own small fixed budget regardless
  // of the user's continueMode setting; the main loop pauses (checkpoint mode) or keeps going
  // until a generous hard ceiling (auto mode, the default) — either way, this is now always a
  // visible event instead of the old silent `return` at a fixed depth of 30.
  if (subagentCtx) {
    if (isSubagentBudgetExceeded(stepCount)) return 'subagent_budget'
  } else {
    const pauseReason = checkStepLimit({
      stepCount,
      continueMode: settings.continueMode,
      checkpointSteps: settings.turnCheckpointSteps
    })
    if (pauseReason) {
      emit({ type: 'turn_paused', tabId: tab.id, reason: pauseReason, stepsCompleted: stepCount })
      return pauseReason
    }
  }

  const models = await fetchModels(apiKey, false, signal)
  const modelInfo = models.find((m) => m.id === tab.model) ?? models[0]
  if (!modelInfo) {
    emit({ type: 'error', tabId: tab.id, message: 'Model not found.' })
    return 'error'
  }

  const compacted = await maybeCompact({
    messages: tab.messages,
    model: modelInfo,
    apiKey,
    signal,
    promptCachingEnabled: settings.promptCachingEnabled,
    utilityModel: settings.utilityModel,
    models
  })
  if (compacted.compacted) {
    tab.messages = compacted.messages
    tab.compactedThroughMessageId = compacted.summaryMessageId
    await sessionStore.updateTab(tab)
    if (compacted.summaryMessageId) emit({ type: 'compaction', tabId: tab.id, summaryMessageId: compacted.summaryMessageId })
  }

  const systemPrompt = await buildSystemPrompt(tab.mode, settings.shellId)
  const orMessages = toORMessages(tab.messages, systemPrompt)

  // Computed from tab.messages before the new (empty) assistant message is pushed below, so
  // the heuristic only ever looks at genuinely prior turns.
  const reasoningEffort = resolveReasoningEffort(tab, modelInfo)
  // 3-way branch: models with granular effort control get the picked effort level; models
  // that support reasoning but not effort levels get `enabled: true` (preserves the previous
  // "always on when supported" behavior); models without reasoning support get neither.
  const supportsGranularEffort =
    reasoningEffort != null && Boolean(modelInfo.supportedReasoningEfforts?.includes(reasoningEffort))
  const reasoningEnabledOnly = modelInfo.supportsReasoning && !supportsGranularEffort

  const assistantId = nanoid()
  const assistantMsg: ChatMessage = {
    id: assistantId,
    role: 'assistant',
    blocks: [],
    createdAt: Date.now(),
    reasoningEffort: supportsGranularEffort ? reasoningEffort : undefined
  }
  tab.messages.push(assistantMsg)
  emit({ type: 'message_start', tabId: tab.id, message: assistantMsg })

  let textBuf = ''
  let thinkingBuf = ''
  let finishReason: string | undefined
  const toolCallsById = new Map<string, ToolCall>()

  // Skip the "last message" cache breakpoint on the very first request of a
  // conversation/subagent run, since there's nothing yet to read back from a cache write
  // and we'd only pay the cache-write premium for no benefit.
  const includeLastMessageCacheBreakpoint = tab.messages.some((m) => m.id !== assistantId && m.usage)
  const supportsExplicitCaching =
    settings.promptCachingEnabled && modelInfo.supportsExplicitCaching && modelSupportsCaching(modelInfo)

  for await (const chunk of streamChatCompletion({
    apiKey,
    model: tab.model,
    messages: orMessages,
    // Subagents can't spawn nested subagents — there's no UI to surface a deeper
    // level's approvals/questions, and it would risk runaway recursion. Coding tools are
    // hidden entirely on the ephemeral Assistant tab (see TabSession.kind) or when no
    // workspace is open — they don't apply there.
    tools: getToolDefinitions(
      tab.mode,
      subagentCtx?.allowedTools,
      isIndexActive(),
      tab.kind !== 'assistant' && Boolean(getWorkspace())
    ).filter(
      (t) => !subagentCtx || t.function.name !== 'task'
    ),
    signal,
    reasoningEffort: supportsGranularEffort ? reasoningEffort : undefined,
    reasoningEnabledOnly,
    sessionId: tab.id,
    providerPreference: settings.providerPreference,
    supportsExplicitCaching,
    includeLastMessageCacheBreakpoint,
    maxTokens: modelInfo.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS
  })) {
    if (signal.aborted) break
    if (chunk.type === 'text' && chunk.text) {
      textBuf += chunk.text
      emit({ type: 'text_delta', tabId: tab.id, messageId: assistantId, delta: chunk.text })
    }
    if (chunk.type === 'reasoning' && chunk.text) {
      thinkingBuf += chunk.text
      emit({ type: 'thinking_delta', tabId: tab.id, messageId: assistantId, delta: chunk.text })
    }
    if (chunk.type === 'tool_calls' && chunk.toolCalls) {
      for (const tc of chunk.toolCalls) toolCallsById.set(tc.id, tc)
    }
    if (chunk.type === 'done' && chunk.finishReason) {
      finishReason = chunk.finishReason
    }
    if (chunk.type === 'usage' && chunk.usage) {
      const { costWithoutCacheUsd, cacheSavingsUsd } = computeCacheSavings(modelInfo, chunk.usage)
      tab.totalCostUsd += chunk.usage.costUsd
      tab.totalSavingsUsd = (tab.totalSavingsUsd ?? 0) + Math.max(cacheSavingsUsd, 0)
      trackDailySpend(chunk.usage.costUsd)
      assistantMsg.usage = {
        promptTokens: chunk.usage.promptTokens,
        completionTokens: chunk.usage.completionTokens,
        cachedTokens: chunk.usage.cachedTokens,
        cacheWriteTokens: chunk.usage.cacheWriteTokens,
        costUsd: chunk.usage.costUsd,
        costWithoutCacheUsd,
        cacheSavingsUsd
      }
      recordUsage(getWorkspace(), tab.model, assistantMsg.usage)
      emit({
        type: 'spend_update',
        tabId: tab.id,
        totalCostUsd: tab.totalCostUsd,
        totalSavingsUsd: tab.totalSavingsUsd,
        capUsd: settings.spendingCapUsd
      })
    }
    if (chunk.type === 'error') {
      emit({ type: 'error', tabId: tab.id, message: chunk.error ?? 'Unknown error' })
      return 'error'
    }
  }

  if (signal.aborted) return 'aborted'

  const toolCalls = [...toolCallsById.values()]

  // Parse each tool call's arguments once here (reused below when recording the message
  // block) so we can also detect, upfront, whether any of them look like they were cut off
  // mid-JSON by the provider's output token limit.
  const parsedArgsByCallId = new Map<string, Record<string, unknown>>()
  let anyArgsUnparsable = false
  for (const tc of toolCalls) {
    try {
      parsedArgsByCallId.set(tc.id, JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>)
    } catch {
      anyArgsUnparsable = true
      parsedArgsByCallId.set(tc.id, {})
    }
  }

  if (thinkingBuf) assistantMsg.blocks.push({ type: 'thinking', text: thinkingBuf })
  if (textBuf) assistantMsg.blocks.push({ type: 'text', text: textBuf })

  // A generation truncated by the provider's output token limit used to look identical to a
  // normal "model is done" stop (no tool calls, or tool calls with garbage args dispatched
  // straight through) — silently ending the turn or failing tools with a confusing error.
  // Detect it and retry instead, up to MAX_TRUNCATION_RETRIES.
  const truncated =
    isTruncatedEmpty(finishReason, toolCalls.length > 0, Boolean(textBuf)) ||
    isTruncatedToolCallJson(finishReason, anyArgsUnparsable)
  if (truncated) {
    emit({ type: 'message_end', tabId: tab.id, messageId: assistantId, usage: assistantMsg.usage })
    await sessionStore.updateTab(tab)
    if (signal.aborted) return 'aborted'

    if (truncationRetries + 1 > MAX_TRUNCATION_RETRIES) {
      emit({
        type: 'error',
        tabId: tab.id,
        message:
          'The model repeatedly cut its response off at the output token limit and retrying did not recover. Try again, or switch to a model with a larger output limit.'
      })
      return 'truncation_failed'
    }
    // Discard this attempt's (possibly garbage) tool calls entirely rather than dispatching
    // them, and re-issue the same request. Doesn't count as a new step — it's a retry of the
    // same one.
    return agentLoop(tab, apiKey, subagentModel, emit, signal, subagentDepth, subagentCtx, stepCount, truncationRetries + 1)
  }

  if (!toolCalls.length) {
    emit({ type: 'message_end', tabId: tab.id, messageId: assistantId, usage: assistantMsg.usage })
    await sessionStore.updateTab(tab)
    return 'natural'
  }

  // Record assistant tool calls in message
  for (const tc of toolCalls) {
    const args = parsedArgsByCallId.get(tc.id) ?? {}
    const block: ToolCallBlock = {
      type: 'tool_call',
      id: tc.id,
      toolName: tc.function.name,
      args,
      status: 'running'
    }
    assistantMsg.blocks.push(block)
    emit({ type: 'tool_call_start', tabId: tab.id, messageId: assistantId, block })
  }

  emit({ type: 'message_end', tabId: tab.id, messageId: assistantId, usage: assistantMsg.usage })
  await sessionStore.updateTab(tab)

  if (signal.aborted) return 'aborted'

  // Execute tools (parallel where independent).
  // Subagents run headless (no UI to answer approvals/questions), so force
  // auto-approval for their mutating tool calls to avoid deadlocking forever.
  const effectiveApprovalMode = subagentCtx ? 'auto' : settings.approvalMode
  const results = await Promise.all(
    toolCalls.map((tc) =>
      executeTool(
        tc,
        tab,
        apiKey,
        subagentModel,
        effectiveApprovalMode,
        emit,
        signal,
        subagentDepth,
        models,
        subagentCtx,
        settings.shellId
      )
    )
  )

  if (signal.aborted) return 'aborted'

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]
    const result = results[i]
    const toolMsg: ChatMessage = {
      id: nanoid(),
      role: 'tool',
      blocks: [
        {
          type: 'tool_call',
          id: tc.id,
          toolName: tc.function.name,
          args: {},
          status: result.status,
          result: result.payload
        }
      ],
      createdAt: Date.now()
    }
    tab.messages.push(toolMsg)

    const block = assistantMsg.blocks.find((b) => b.type === 'tool_call' && b.id === tc.id) as ToolCallBlock | undefined
    if (block) {
      block.status = result.status
      block.result = result.payload
      emit({
        type: 'tool_call_result',
        tabId: tab.id,
        messageId: assistantId,
        toolCallId: tc.id,
        result: result.payload,
        status: result.status
      })
    }
  }

  await sessionStore.updateTab(tab)
  if (signal.aborted) return 'aborted'
  return agentLoop(tab, apiKey, subagentModel, emit, signal, subagentDepth, subagentCtx, stepCount + 1, 0)
}

async function executeTool(
  tc: ToolCall,
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  approvalMode: 'manual' | 'auto',
  emit: Emit,
  signal: AbortSignal,
  subagentDepth: number,
  models: ModelInfo[],
  subagentCtx?: SubagentContext,
  shellId?: string | null
): Promise<{ payload: ToolResultPayload; status: ToolCallBlock['status'] }> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
  } catch {
    return { payload: { ok: false, summary: 'Invalid JSON args', error: 'parse' }, status: 'error' }
  }

  const name = tc.function.name

  if (name === 'ask_question') {
    // Subagents run headless — there is no UI to ever answer this, so it would
    // hang forever waiting on a promise that never resolves. Fail fast instead.
    if (subagentCtx) {
      return {
        payload: {
          ok: false,
          summary: 'ask_question is not available inside a subagent. Make a reasonable assumption and continue, or report the ambiguity in your final summary.',
          error: 'unsupported_in_subagent'
        },
        status: 'error'
      }
    }
    const questions = (args.questions as PendingQuestion['questions']) ?? []
    const pq: PendingQuestion = {
      id: nanoid(),
      tabId: tab.id,
      toolCallId: tc.id,
      questions,
      createdAt: Date.now()
    }
    pendingQuestions.set(pq.id, pq)
    emit({ type: 'pending_question', tabId: tab.id, question: pq })
    const answers = await new Promise<QuestionAnswer[]>((resolve) => questionWaiters.set(pq.id, resolve))
    emit({ type: 'pending_question_resolved', tabId: tab.id, questionId: pq.id })
    return {
      payload: { ok: true, summary: 'User answered questions', data: { answers } },
      status: 'success'
    }
  }

  if (['write_file', 'edit_file', 'delete_file', 'run_command'].includes(name)) {
    if (approvalMode === 'manual') {
      const kind = name as PendingActionKind
      const preview = await previewMutatingTool(name, args)
      const action = approvalManager.buildPendingFromTool(tab.id, tc.id, kind, preview.title, preview.extra)
      emit({ type: 'pending_action', tabId: tab.id, action })
      const decision = await approvalManager.waitForDecision(action.id)
      emit({ type: 'pending_action_resolved', tabId: tab.id, actionId: action.id })
      if (decision === 'reject') {
        return { payload: { ok: false, summary: 'User rejected action', error: 'rejected' }, status: 'rejected' }
      }
    } else {
      const ws = getWorkspace()
      if (ws) await approvalManager.createCheckpoint(ws)
    }
  }

  try {
    const payload = await dispatchTool(name, args, tab, apiKey, subagentModel, emit, signal, subagentDepth, models, shellId)
    return { payload, status: payload.ok ? 'success' : 'error' }
  } catch (e) {
    return {
      payload: { ok: false, summary: 'Tool failed', error: e instanceof Error ? e.message : String(e) },
      status: 'error'
    }
  }
}

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  emit: Emit,
  signal: AbortSignal,
  subagentDepth: number,
  models: ModelInfo[],
  shellId?: string | null
): Promise<ToolResultPayload> {
  switch (name) {
    case 'read_file':
      return readFileTool(args as { path: string; offset?: number; limit?: number })
    case 'write_file':
      return writeFileTool(args as { path: string; content: string })
    case 'edit_file':
      return editFileTool(
        args as { path: string; old_string: string; new_string: string; replace_all?: boolean }
      )
    case 'delete_file':
      return deleteFileTool(args as { path: string })
    case 'grep':
      return grepTool(
        args as { pattern: string; path?: string; glob?: string; case_insensitive?: boolean; context?: number },
        signal
      )
    case 'glob':
      return globTool(args as { pattern: string; cwd?: string })
    case 'run_command':
      return runCommandTool(args as { command: string; cwd?: string; timeout_ms?: number }, signal, shellId)
    case 'web_search':
      return webSearchTool(args as { query: string })
    case 'fetch_url':
      return fetchUrlTool(args as { url: string })
    case 'list_skills': {
      const skills = await listSkills()
      return { ok: true, summary: `${skills.length} skills`, data: { skills } }
    }
    case 'read_skill':
      return { ok: true, summary: 'Skill loaded', data: { content: await readSkill(String(args.path)) } }
    case 'read_memory': {
      try {
        const content = await readMemoryTopic(args.scope as 'project' | 'global', String(args.topic))
        return { ok: true, summary: `Read memory topic "${String(args.topic)}"`, data: { content } }
      } catch (e) {
        return {
          ok: false,
          summary: `Memory topic "${String(args.topic)}" not found`,
          error: e instanceof Error ? e.message : String(e)
        }
      }
    }
    case 'write_memory':
      await writeMemory(args.scope as 'project' | 'global', String(args.topic), String(args.content))
      return { ok: true, summary: 'Memory saved' }
    case 'list_projects':
      return listProjectsTool()
    case 'read_other_project_file':
      return readOtherProjectFileTool(
        args as { project: string; path: string; offset?: number; limit?: number }
      )
    case 'grep_other_project':
      return grepOtherProjectTool(
        args as {
          project: string
          pattern: string
          path?: string
          glob?: string
          case_insensitive?: boolean
          context?: number
        }
      )
    case 'glob_other_project':
      return globOtherProjectTool(args as { project: string; pattern: string; cwd?: string })
    case 'read_other_project_memory':
      return readOtherProjectMemoryTool(args as { project: string; scope: 'project' | 'global'; topic?: string })
    case 'save_plan': {
      const plan = await savePlan(String(args.slug), String(args.title), String(args.markdown))
      return { ok: true, summary: 'Plan saved', data: { plan } }
    }
    case 'task':
      return runSubagent(tab, apiKey, subagentModel, args, emit, signal, subagentDepth)
    case 'codebase_search': {
      const query = String(args.query ?? '')
      const topK = typeof args.topK === 'number' ? args.topK : 8
      try {
        const hits = await searchCode(query, topK, models)
        return { ok: true, summary: `Found ${hits.length} relevant code chunks`, data: { hits } }
      } catch (e) {
        return { ok: false, summary: 'codebase_search failed', error: e instanceof Error ? e.message : String(e) }
      }
    }
    case 'open_settings_panel': {
      const section = String(args.section ?? 'integrations')
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('settings:navigate', section)
      }
      return { ok: true, summary: `Opened Settings \u2192 ${section}` }
    }
    case 'gmail_list_messages':
      return gmailListMessagesTool(args as { query?: string; maxResults?: number })
    case 'gmail_get_message':
      return gmailGetMessageTool(args as { id: string })
    case 'gmail_send_message':
      return gmailSendMessageTool(args as { to: string; subject: string; body: string })
    case 'discord_post_message':
      return discordPostMessageTool(args as { channelId: string; text: string })
    case 'scheduler_create_task': {
      const task = await scheduledTaskManager.create({
        name: String(args.name),
        prompt: String(args.prompt),
        schedule: String(args.schedule),
        targetWorkspace: args.targetWorkspace ? String(args.targetWorkspace) : null,
        maxCostUsd: typeof args.maxCostUsd === 'number' ? args.maxCostUsd : null
      })
      return { ok: true, summary: `Created scheduled task "${task.name}"`, data: { task } }
    }
    case 'scheduler_list_tasks': {
      const tasks = scheduledTaskManager.list()
      return { ok: true, summary: `${tasks.length} scheduled task(s)`, data: { tasks } }
    }
    case 'scheduler_update_task': {
      const id = String(args.id)
      const patch: Record<string, unknown> = { ...args }
      delete patch.id
      const task = await scheduledTaskManager.update(id, patch)
      if (!task) return { ok: false, summary: `No scheduled task with id ${id}`, error: 'not_found' }
      return { ok: true, summary: `Updated scheduled task "${task.name}"`, data: { task } }
    }
    case 'scheduler_delete_task': {
      await scheduledTaskManager.delete(String(args.id))
      return { ok: true, summary: 'Scheduled task deleted' }
    }
    default:
      return { ok: false, summary: `Unknown tool ${name}`, error: 'unknown' }
  }
}

/** Short, human-readable label for what a subagent tool call is doing, shown live in the Subagents panel while status === 'running'. */
function describeToolActivity(toolName: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  switch (toolName) {
    case 'read_file':
      return `Reading ${str(args.path) ?? 'file'}`
    case 'write_file':
      return `Writing ${str(args.path) ?? 'file'}`
    case 'edit_file':
      return `Editing ${str(args.path) ?? 'file'}`
    case 'delete_file':
      return `Deleting ${str(args.path) ?? 'file'}`
    case 'grep':
      return `Searching for "${str(args.pattern) ?? ''}"`
    case 'glob':
      return `Finding files matching "${str(args.pattern) ?? ''}"`
    case 'run_command':
      return `Running: ${str(args.command) ?? 'command'}`
    case 'web_search':
      return `Searching the web for "${str(args.query) ?? ''}"`
    case 'fetch_url':
      return `Fetching ${str(args.url) ?? 'url'}`
    case 'list_skills':
      return 'Listing skills'
    case 'read_skill':
      return `Reading skill ${str(args.path) ?? ''}`
    case 'read_memory':
      return `Reading memory "${str(args.topic) ?? ''}"`
    case 'write_memory':
      return `Writing memory "${str(args.topic) ?? ''}"`
    case 'ask_question':
      return 'Asking a clarifying question'
    case 'codebase_search':
      return `Searching codebase for "${str(args.query) ?? ''}"`
    case 'list_projects':
      return 'Listing other known projects'
    case 'read_other_project_file':
      return `Reading ${str(args.path) ?? 'file'} from ${str(args.project) ?? 'another project'}`
    case 'grep_other_project':
      return `Searching "${str(args.pattern) ?? ''}" in ${str(args.project) ?? 'another project'}`
    case 'glob_other_project':
      return `Finding files matching "${str(args.pattern) ?? ''}" in ${str(args.project) ?? 'another project'}`
    case 'read_other_project_memory':
      return `Reading memory from ${str(args.project) ?? 'another project'}`
    case 'open_settings_panel':
      return `Opening Settings \u2192 ${str(args.section) ?? 'integrations'}`
    case 'gmail_list_messages':
      return 'Checking Gmail'
    case 'gmail_get_message':
      return 'Reading an email'
    case 'gmail_send_message':
      return `Sending an email to ${str(args.to) ?? ''}`
    case 'discord_post_message':
      return 'Posting to Discord'
    case 'scheduler_create_task':
      return `Creating scheduled task "${str(args.name) ?? ''}"`
    case 'scheduler_list_tasks':
      return 'Listing scheduled tasks'
    case 'scheduler_update_task':
      return 'Updating a scheduled task'
    case 'scheduler_delete_task':
      return 'Deleting a scheduled task'
    default:
      return `Running ${toolName}`
  }
}

async function runSubagent(
  parentTab: TabSession,
  apiKey: string,
  defaultSubModel: string,
  args: Record<string, unknown>,
  emit: Emit,
  signal: AbortSignal,
  subagentDepth: number
): Promise<ToolResultPayload> {
  const agentType = String(args.agent_type)
  const prompt = String(args.prompt)
  const desc = String(args.description ?? agentType)
  const typeDef = await getSubagentType(agentType)
  if (!typeDef) return { ok: false, summary: `Unknown subagent ${agentType}`, error: 'unknown_agent' }

  const run: SubagentRun = {
    id: nanoid(),
    parentTabId: parentTab.id,
    agentType,
    description: desc,
    status: 'running',
    activity: 'Thinking...',
    startedAt: Date.now()
  }
  emit({ type: 'subagent_update', tabId: parentTab.id, run })

  const subTab: TabSession = {
    id: `sub_${run.id}`,
    title: `Sub: ${agentType}`,
    mode: 'agent',
    model: typeDef.model ?? defaultSubModel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      {
        id: nanoid(),
        role: 'user',
        blocks: [{ type: 'text', text: prompt }],
        createdAt: Date.now()
      }
    ],
    totalCostUsd: 0,
    totalSavingsUsd: 0
  }

  // Forward the subagent's events to the UI (so its messages/tool calls are visible,
  // e.g. in a subagent detail view) in addition to tracking them for the summary below.
  const events: AgentStreamEvent[] = []
  // Once the subagent has done at least one real tool call, stop letting "Thinking..." (from
  // message_start/thinking_delta, which fire every single step while the model reasons about
  // what to do next) stomp back over that tool's activity label. Otherwise the panel flickers
  // to the interesting status for a split second and then reverts to "Thinking..." for the
  // remainder of that step, which is almost all a user ever sees. Once we've shown real activity,
  // only a new tool_call_start is allowed to replace it — the label just sticks until then.
  let sawToolActivity = false
  const capture = (e: AgentStreamEvent) => {
    events.push(e)
    emit(e)

    // Keep the run's "activity" label current so the Subagents panel shows what the
    // subagent is doing right now instead of a static "running" state.
    let activity: string | undefined
    if (e.type === 'tool_call_start') {
      activity = describeToolActivity(e.block.toolName, e.block.args)
      sawToolActivity = true
    } else if (!sawToolActivity && (e.type === 'message_start' || e.type === 'thinking_delta')) {
      activity = 'Thinking...'
    }
    if (activity && activity !== run.activity) {
      run.activity = activity
      emit({ type: 'subagent_update', tabId: parentTab.id, run })
    }
  }

  const subagentCtx: SubagentContext = { allowedTools: typeDef.tools }

  try {
    const reason = await agentLoop(subTab, apiKey, defaultSubModel, capture, signal, subagentDepth + 1, subagentCtx)
    let summary =
      subTab.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n') || 'Subagent completed with no text output.'

    if (reason === 'subagent_budget') {
      summary += '\n\n[Stopped: subagent reached its step budget before finishing — the summary above reflects partial progress only.]'
    }

    run.status = reason === 'error' || reason === 'truncation_failed' ? 'error' : 'success'
    run.summary = truncateSummary(summary)
    run.activity = undefined
    run.finishedAt = Date.now()
    emit({ type: 'subagent_update', tabId: parentTab.id, run })
    emit({ type: 'turn_end', tabId: subTab.id })

    if (!BrowserWindow.getFocusedWindow()) {
      new Notification({ title: 'Klenny Code subagent finished', body: `${agentType}: ${desc}` }).show()
    }

    return { ok: run.status === 'success', summary: run.summary, data: { run } }
  } catch (e) {
    run.status = 'error'
    run.summary = e instanceof Error ? e.message : String(e)
    run.activity = undefined
    run.finishedAt = Date.now()
    emit({ type: 'subagent_update', tabId: parentTab.id, run })
    emit({ type: 'turn_end', tabId: subTab.id })
    return { ok: false, summary: run.summary, error: 'subagent_error' }
  }
}

/** Runs one scheduled task (Phase 4 of the Personal Assistant Platform plan) as a fully
 *  unattended subagent — no parent tab, no live UI to stream to. Registered with
 *  scheduledTaskManager.setRunner() at app startup (see main/index.ts) to avoid a circular
 *  import between this module and scheduler/manager.ts.
 *
 *  Scheduled-task runs never get scheduler_create_task/update/delete in their tool allowlist —
 *  a scheduled task cannot create, edit, or delete other scheduled tasks (no metaprogramming;
 *  see the plan's runaway-cost mitigation). If `task.targetWorkspace` is set, the global
 *  workspace is temporarily switched to it for the duration of the run and restored afterward —
 *  a known limitation: if the user is actively working in a different project tab while a
 *  scheduled task fires, coding-tool calls in *that* live tab could transiently resolve against
 *  the scheduled task's workspace until it finishes. Acceptable for v1; a future version could
 *  give every tab its own workspace instead of one global one. */
export async function runScheduledTask(
  task: import('@shared/types').ScheduledTask
): Promise<{ status: 'success' | 'error'; summaryPreview: string }> {
  const apiKey = await getApiKey()
  if (!apiKey) return { status: 'error', summaryPreview: 'OpenRouter API key not set.' }

  const settings = await loadSettings()
  if (settings.automationPermissions['scheduler.run'] !== 'auto') {
    return { status: 'error', summaryPreview: 'Scheduler is disabled by Automation Permissions (scheduler.run).' }
  }

  const previousWorkspace = getWorkspace()
  if (task.targetWorkspace) setWorkspace(task.targetWorkspace)

  const subTab: TabSession = {
    id: `sched_${task.id}_${Date.now()}`,
    title: `Scheduled: ${task.name}`,
    mode: 'agent',
    model: settings.subagentModel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // No targetWorkspace => force the assistant tool-only allowlist regardless of whatever
    // project happens to be the ambient global workspace right now (see getWorkspace() gating
    // in the tools: getToolDefinitions(...) call above).
    kind: task.targetWorkspace ? 'project' : 'assistant',
    messages: [
      {
        id: nanoid(),
        role: 'user',
        blocks: [{ type: 'text', text: task.prompt }],
        createdAt: Date.now()
      }
    ],
    totalCostUsd: 0,
    totalSavingsUsd: 0
  }

  const subagentCtx: SubagentContext = {
    allowedTools: [
      'read_file',
      'grep',
      'glob',
      'run_command',
      'web_search',
      'fetch_url',
      'read_memory',
      'write_memory',
      'list_projects',
      'read_other_project_file',
      'grep_other_project',
      'glob_other_project',
      'read_other_project_memory',
      'gmail_list_messages',
      'gmail_get_message',
      'gmail_send_message',
      'discord_post_message',
      'codebase_search'
      // Deliberately excluded: write_file/edit_file/delete_file (still permitted via
      // ApprovalManager bypass same as any subagent, but not the point of most scheduled
      // tasks — can be revisited if a real use case needs it), scheduler_* (no
      // metaprogramming), open_settings_panel (no renderer to navigate), task (no nested
      // subagents, same as all subagent contexts).
    ]
  }

  const controller = new AbortController()
  try {
    const reason = await agentLoop(subTab, apiKey, settings.subagentModel, emitToAll, controller.signal, 1, subagentCtx)
    const summary =
      subTab.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n') || 'Scheduled task completed with no text output.'
    const status = reason === 'error' || reason === 'truncation_failed' ? 'error' : 'success'
    return { status, summaryPreview: truncateSummary(summary) }
  } catch (e) {
    return { status: 'error', summaryPreview: e instanceof Error ? e.message : String(e) }
  } finally {
    setWorkspace(previousWorkspace)
  }
}

/** Runs an inbound Discord command (see discordBridge.ts) as a fully unattended subagent and
 *  returns the reply text to post back to Discord. Same tool allowlist rationale as
 *  runScheduledTask (no scheduler_x tools, no open_settings_panel, no nested task calls), plus
 *  `discord_post_message` so the subagent could proactively post to a different channel if
 *  asked, though its primary reply is always the returned string (posted by the Discord
 *  message-handler itself). */
export async function runDiscordSubagent(subTab: TabSession, apiKey: string, subagentModel: string): Promise<string> {
  const subagentCtx: SubagentContext = {
    allowedTools: [
      'web_search',
      'fetch_url',
      'read_memory',
      'write_memory',
      'list_projects',
      'read_other_project_file',
      'grep_other_project',
      'glob_other_project',
      'read_other_project_memory',
      'gmail_list_messages',
      'gmail_get_message',
      'gmail_send_message',
      'discord_post_message'
    ]
  }
  const controller = new AbortController()
  try {
    const reason = await agentLoop(subTab, apiKey, subagentModel, emitToAll, controller.signal, 1, subagentCtx)
    const summary =
      subTab.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n') || "Sorry, I didn't have anything to say."
    if (reason === 'error' || reason === 'truncation_failed') {
      return `Sorry, something went wrong while handling that: ${summary}`
    }
    return summary
  } catch (e) {
    return `Sorry, something went wrong: ${e instanceof Error ? e.message : String(e)}`
  }
}

async function buildSystemPrompt(mode: 'agent' | 'plan', shellId?: string | null): Promise<string> {
  const ws = getWorkspace()
  const [projMem, globalMem, autoMem, skills, subagents, otherProjects] = await Promise.all([
    loadProjectMemory(),
    loadGlobalMemory(),
    loadAutoMemoryIndex(),
    listSkills(),
    listSubagentTypes(),
    listKnownProjects()
  ])

  const shell = resolveShell(shellId)

  const parts = [
    mode === 'plan' ? PLAN_MODE_PROMPT : AGENT_MODE_PROMPT,
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

async function previewMutatingTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ title: string; extra: Partial<import('@shared/types').PendingAction> }> {
  if (name === 'run_command') {
    return {
      title: `Run command: ${args.command}`,
      extra: { command: String(args.command), cwd: args.cwd ? String(args.cwd) : undefined }
    }
  }
  const path = String(args.path ?? '')
  if (name === 'write_file') {
    let oldContent = ''
    try {
      const abs = resolveWorkspacePath(path)
      oldContent = toLf(await readFile(abs, 'utf8'))
    } catch {
      // new file — diff against empty content
    }
    return { title: `Write ${path}`, extra: { filePath: path, diff: makeDiff(oldContent, String(args.content), path) } }
  }
  if (name === 'edit_file') {
    try {
      const abs = resolveWorkspacePath(path)
      const content = toLf(await readFile(abs, 'utf8'))
      const match = resolveEditMatch(content, String(args.old_string), String(args.new_string))
      if (!match) return { title: `Edit ${path}`, extra: { filePath: path } }
      const updated = args.replace_all
        ? content.replaceAll(match.oldString, match.newString)
        : content.replace(match.oldString, match.newString)
      return { title: `Edit ${path}`, extra: { filePath: path, diff: makeDiff(content, updated, path) } }
    } catch {
      return { title: `Edit ${path}`, extra: { filePath: path } }
    }
  }
  try {
    const abs = resolveWorkspacePath(path)
    const oldContent = toLf(await readFile(abs, 'utf8'))
    return { title: `Delete ${path}`, extra: { filePath: path, diff: makeDiff(oldContent, '', path) } }
  } catch {
    return { title: `Delete ${path}`, extra: { filePath: path } }
  }
}

function checkSpendCap(tab: TabSession, cap: number | null, period: 'session' | 'daily'): void {
  if (!cap) return
  const spend = period === 'daily' ? getDailySpend() : tab.totalCostUsd
  if (spend >= cap) {
    emitToAll({ type: 'spend_blocked', tabId: tab.id })
    throw new Error('Spending cap exceeded')
  }
}

export function getPendingQuestions(): PendingQuestion[] {
  return [...pendingQuestions.values()]
}
