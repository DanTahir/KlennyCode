// The core, mutually-recursive heart of the orchestrator: agentLoop() streams a model turn and
// executes any tool calls it makes; one of those tools (`task`) is runSubagent(), which spawns
// an isolated sub-conversation that itself calls agentLoop() again. executeTool()/dispatchTool()
// sit in between, gating approval and routing each tool call to its implementation.
//
// These four functions (agentLoop, executeTool, dispatchTool, runSubagent) are kept in one file
// deliberately: agentLoop -> executeTool -> dispatchTool -> (task tool) -> runSubagent ->
// agentLoop is a genuine recursive cycle inherent to how subagents work, not an artifact of file
// layout. Splitting them across separate files would create a real circular-import graph across
// module boundaries, which is worse than one large, clearly-scoped file. If you're adding a new
// tool handler, prefer adding a case to dispatchTool's switch rather than growing agentLoop or
// executeTool themselves.
import { BrowserWindow, Notification } from 'electron'
import { nanoid } from 'nanoid'
import type {
  AgentStreamEvent,
  ApprovalMode,
  BrowserAutomationSettings,
  ChatMessage,
  ContentBlock,
  ModelInfo,
  PendingActionKind,
  PendingQuestion,
  ScheduledTask,
  SubagentRun,
  TabSession,
  ToolCallBlock,
  ToolResultPayload
} from '@shared/types'
import { DEFAULT_BROWSER_AUTOMATION, CODING_ONLY_TOOLS } from '@shared/types'
import { loadSettings } from '../../settings'
import { getWorkspace } from '../../workspace'
import { sessionStore } from '../../session/store'
import { streamChatCompletion, fetchModels, type ToolCall } from '../../openrouter/client'
import { modelSupportsCaching, computeCacheSavings } from '../../openrouter/caching'
import { getToolDefinitions } from '../tools/definitions'
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditFileTool,
  normalizeEditsArg,
  type MultiEditOp,
  deleteFileTool,
  grepTool,
  globTool,
  runCommandTool,
  readTerminalTool,
  webSearchTool,
  fetchUrlTool
} from '../tools/index'
import { browserTool, isBrowserActionMutating, buildBrowserApprovalPreview } from '../tools/browser'
import { disposeSession as disposeBrowserSession } from '../../browser/manager'
import { listProjectsTool, resolveProjectOrError } from '../tools/otherProjects'
import { writeMemory, readMemoryTopic, loadProjectMemory, loadAutoMemoryIndex, loadGlobalMemory, listMemoryTopics } from '../memory/manager'
import { buildFullAssistantMemoryDigest } from '../memory/assistantMemory'
import { listSkills, readSkill, writeSkill } from '../skills/manager'
import { getSubagentType, writeSubagentType } from '../subagents/manager'
import { savePlan } from '../plan/manager'
import { approvalManager } from '../approval/manager'
import { maybeCompact } from '../compaction/compactor'
import { resolveReasoningEffort } from '../reasoning'
import { toORMessages, messagesForWire } from '../messages'
import { trackDailySpend } from '../spend'
import { recordUsage } from '../costReport'
import { isIndexActive, searchCode } from '../codeindex/manager'
import { gmailListMessagesTool, gmailGetMessageTool, gmailSendMessageTool } from '../../integrations/gmail'
import { discordPostMessageTool } from '../../integrations/discord'
import { scheduledTaskManager } from '../../scheduler/manager'
import {
  MAX_SUBAGENT_DEPTH,
  MAX_TRUNCATION_RETRIES,
  DEFAULT_MAX_COMPLETION_TOKENS,
  checkStepLimit,
  isSubagentBudgetExceeded,
  isTruncatedEmpty,
  isTruncatedToolCallJson,
  truncateSummary
} from '../turnControl'
import { buildSystemPrompt, buildCurrentTimeNote } from './system-prompt'
import { previewMutatingTool } from './approval-previews'
import {
  type Emit,
  type LoopStopReason,
  type SubagentContext,
  throwIfAborted,
  pendingQuestions,
  questionWaiters,
  lastCacheBreakpointIdx
} from './state'

export async function agentLoop(
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
    models,
    priorSummary: tab.compactionSummary,
    priorCompactedThroughMessageId: tab.compactedThroughMessageId
  })
  if (compacted.compacted && compacted.summary && compacted.compactedThroughMessageId) {
    // `tab.messages` (the UI-facing history) is left completely untouched here — only these two
    // fields change, and they're consulted below (via `messagesForWire`/`toORMessages`) purely
    // to shrink what's sent to the model, not what the user sees in the chat.
    tab.compactionSummary = compacted.summary
    tab.compactedThroughMessageId = compacted.compactedThroughMessageId
    // Compaction reshuffles wire-message indices (a different prefix is now dropped/replaced by
    // the summary), so a previously-tracked breakpoint index would silently point at unrelated
    // content this turn — drop it rather than re-mark the wrong message.
    lastCacheBreakpointIdx.delete(tab.id)
    await sessionStore.updateTab(tab)
    emit({
      type: 'compaction',
      tabId: tab.id,
      compactedThroughMessageId: compacted.compactedThroughMessageId,
      summary: compacted.summary
    })
  }

  const systemPrompt = await buildSystemPrompt(
    tab.mode,
    settings.shellId,
    subagentCtx,
    tab.kind === 'assistant' ? 'assistant' : 'project'
  )
  const orMessages = toORMessages(
    messagesForWire(tab.messages, tab.compactedThroughMessageId),
    systemPrompt,
    tab.compactionSummary,
    compacted.compacted
  )

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
  const priorCacheBreakpointIdx = lastCacheBreakpointIdx.get(tab.id)
  // This request's own breakpoint, so next turn can explicitly re-mark it too — see
  // applyCacheControl's doc comment for why that beats relying on implicit cross-request
  // lookback. `currentTimeNote` (passed below) is always non-empty, so applyCacheControl always
  // reserves the true last wire message for it and marks the message one before that instead —
  // this must track the exact same index (orMessages.length - 2, not - 1) or a future turn would
  // re-mark the wrong message. Recorded now (rather than after the call) since orMessages.length
  // is already final at this point, and both settings.promptCachingEnabled and modelInfo can
  // change turn to turn — the value is harmless to keep around even if unused this turn.
  if (includeLastMessageCacheBreakpoint) {
    lastCacheBreakpointIdx.set(tab.id, orMessages.length - 2)
  }

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
    priorCacheBreakpointIdx,
    maxTokens: modelInfo.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    currentTimeNote: await buildCurrentTimeNote(tab.kind === 'assistant' ? tab.id : undefined)
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
  // Otherwise a tab's own approval-mode override (set via the dropdown next to Send/Stop,
  // or by "Accept all" on a pending action) wins over the global settings default.
  const tabApprovalMode = tab.approvalMode
  const effectiveApprovalMode: ApprovalMode = subagentCtx
    ? 'auto'
    : tabApprovalMode && tabApprovalMode !== 'default'
      ? tabApprovalMode
      : settings.approvalMode
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
        assistantId,
        subagentCtx,
        settings.shellId,
        settings.browserAutomation
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
  approvalMode: ApprovalMode,
  emit: Emit,
  signal: AbortSignal,
  subagentDepth: number,
  models: ModelInfo[],
  assistantMessageId: string,
  subagentCtx?: SubagentContext,
  shellId?: string | null,
  browserAutomation?: BrowserAutomationSettings
): Promise<{ payload: ToolResultPayload; status: ToolCallBlock['status'] }> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
  } catch {
    return { payload: { ok: false, summary: 'Invalid JSON args', error: 'parse' }, status: 'error' }
  }

  const name = tc.function.name

  // Defense-in-depth server-side gate, independent of getToolDefinitions() only hiding these
  // tools from the model on Assistant-kind tabs: getWorkspace() is a process-global singleton
  // (see workspace.ts), so if the tool ever reaches dispatch anyway — a hallucinated call, stale
  // conversation history referencing an old tool, a subagent misconfiguration, etc. — it would
  // otherwise silently execute against whatever project some *other* window has open. Reject
  // outright rather than relying solely on the tool list never advertising it. See "Coding tools
  // available inside an Assistant-kind tab" memory.
  if (tab.kind === 'assistant' && (CODING_ONLY_TOOLS as string[]).includes(name)) {
    return {
      payload: {
        ok: false,
        summary: `${name} is not available in an Assistant tab (no project workspace).`,
        error: 'no_workspace'
      },
      status: 'error'
    }
  }

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
    const answers = await new Promise<import('@shared/types').QuestionAnswer[]>((resolve) => questionWaiters.set(pq.id, resolve))
    emit({ type: 'pending_question_resolved', tabId: tab.id, questionId: pq.id })
    return {
      payload: { ok: true, summary: 'User answered questions', data: { answers } },
      status: 'success'
    }
  }

  if (['write_file', 'edit_file', 'multi_edit', 'delete_file', 'run_command'].includes(name)) {
    // 'manual': everything needs review. 'command': only run_command needs review — file edits
    // are auto-applied like 'auto' mode. 'auto': nothing needs review.
    const needsApproval = approvalMode === 'manual' || (approvalMode === 'command' && name === 'run_command')
    if (needsApproval) {
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

  // Browser automation has its own independent gate — separate from the tab's approvalMode —
  // driven by Settings -> Automation -> Browser automation's policy ('off'/'ask'/'auto'). Owner
  // id is the tab id for interactive runs; subagents get their own ephemeral tab id (sub_<runId>
  // / sched_<taskId>_<ts>, see runSubagent/runScheduledTask) so their browser sessions never
  // collide with the parent tab's.
  if (name === 'browser') {
    const policy = browserAutomation?.policy ?? 'off'
    if (policy === 'off') {
      return {
        payload: {
          ok: false,
          summary: 'Browser automation is disabled — enable it in Settings \u2192 Automation \u2192 Browser automation.',
          error: 'browser_disabled'
        },
        status: 'error'
      }
    }
    const browserAction = String(args.action ?? '')
    if (isBrowserActionMutating(browserAction)) {
      // Subagents have no UI to answer an approval prompt — same reasoning as
      // effectiveApprovalMode forcing 'auto' for the other mutating tools above, this bypasses
      // the queue rather than hanging forever. Policy='off' already blocked above regardless.
      const needsApproval = !subagentCtx && policy === 'ask'
      if (needsApproval) {
        const previewCtx = { ownerId: tab.id, unattended: false, settings: browserAutomation! }
        const preview = await buildBrowserApprovalPreview(args, previewCtx)
        const action = approvalManager.buildPendingFromTool(tab.id, tc.id, 'browser_act', preview.title, {
          screenshotDataUrl: preview.screenshotDataUrl
        })
        emit({ type: 'pending_action', tabId: tab.id, action })
        const decision = await approvalManager.waitForDecision(action.id)
        emit({ type: 'pending_action_resolved', tabId: tab.id, actionId: action.id })
        if (decision === 'reject') {
          return { payload: { ok: false, summary: 'User rejected action', error: 'rejected' }, status: 'rejected' }
        }
      }
    }
  }

  try {
    // Only the browser tool's one-time Chromium download uses this today — cosmetic progress
    // for a still-`running` tool call, never affecting status. See `tool_call_progress` in
    // shared/types.ts.
    const onToolProgress = (message: string) =>
      emit({ type: 'tool_call_progress', tabId: tab.id, messageId: assistantMessageId, toolCallId: tc.id, message })
    const payload = await dispatchTool(
      name,
      args,
      tab,
      apiKey,
      subagentModel,
      emit,
      signal,
      subagentDepth,
      models,
      shellId,
      Boolean(subagentCtx),
      browserAutomation,
      onToolProgress
    )
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
  shellId?: string | null,
  unattended = false,
  browserAutomation?: BrowserAutomationSettings,
  onToolProgress?: (message: string) => void
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
    case 'multi_edit':
      return multiEditFileTool(args as unknown as { edits: MultiEditOp[] })
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
    case 'read_terminal':
      return readTerminalTool(args as { lines?: number })
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
      if (args.scope === 'assistant') {
        const content = await buildFullAssistantMemoryDigest()
        return {
          ok: true,
          summary: content ? 'Read assistant memory digest' : 'Assistant memory is empty or disabled',
          data: { content }
        }
      }
      // 'project' scope: an optional `project` name resolves to a DIFFERENT known project's
      // memory (see otherProjects.ts) instead of the current workspace's — 'global' memory is
      // shared everywhere so `project` is meaningless there.
      let projectRoot: string | undefined
      if (args.scope === 'project' && args.project) {
        const resolved = await resolveProjectOrError(String(args.project))
        if ('error' in resolved) return resolved.error
        projectRoot = resolved.root
      }
      try {
        const content = await readMemoryTopic(args.scope as 'project' | 'global', String(args.topic), projectRoot)
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
      // Writes stay scoped to the current workspace/global memory only — there is deliberately
      // no `project` argument here, unlike read_memory/list_memory. Klenny should never write
      // notes into a project it isn't currently open in.
      await writeMemory(args.scope as 'project' | 'global', String(args.topic), String(args.content))
      return { ok: true, summary: 'Memory saved' }
    case 'list_memory': {
      const scope = args.scope as 'project' | 'global'
      let projectRoot: string | undefined
      if (scope === 'project' && args.project) {
        const resolved = await resolveProjectOrError(String(args.project))
        if ('error' in resolved) return resolved.error
        projectRoot = resolved.root
      }
      const [klennyMd, autoIndex, topics] = await Promise.all([
        scope === 'global' ? loadGlobalMemory() : loadProjectMemory(projectRoot),
        scope === 'global' ? Promise.resolve('') : loadAutoMemoryIndex(projectRoot),
        listMemoryTopics(scope, projectRoot)
      ])
      const content = [klennyMd, autoIndex].filter(Boolean).join('\n\n')
      return {
        ok: true,
        summary: `${scope === 'global' ? 'Global' : projectRoot ?? 'current project'} memory overview (${topics.length} auto-memory topic(s))`,
        data: { project: projectRoot, content, topics }
      }
    }
    case 'write_skill': {
      try {
        await writeSkill(String(args.name), args.scope as 'project' | 'global', String(args.description), String(args.body))
        return { ok: true, summary: `Skill "${String(args.name)}" saved (${String(args.scope)})` }
      } catch (e) {
        return { ok: false, summary: 'Failed to save skill', error: e instanceof Error ? e.message : String(e) }
      }
    }
    case 'write_subagent': {
      try {
        const toolsArg = args.tools === 'all' ? 'all' : (Array.isArray(args.tools) ? (args.tools as string[]) : [])
        await writeSubagentType(
          String(args.name),
          args.scope as 'project' | 'global',
          String(args.description),
          toolsArg,
          args.model ? String(args.model) : undefined,
          String(args.body)
        )
        return { ok: true, summary: `Subagent "${String(args.name)}" saved (${String(args.scope)})` }
      } catch (e) {
        return { ok: false, summary: 'Failed to save subagent', error: e instanceof Error ? e.message : String(e) }
      }
    }
    case 'read_subagent': {
      const found = await getSubagentType(String(args.name))
      if (!found) {
        return { ok: false, summary: `Subagent "${String(args.name)}" not found`, error: 'not found' }
      }
      return { ok: true, summary: `Subagent "${found.name}" loaded`, data: { subagent: found } }
    }
    case 'list_projects':
      return listProjectsTool()
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
        maxCostUsd: typeof args.maxCostUsd === 'number' ? args.maxCostUsd : null,
        maxRuns: typeof args.maxRuns === 'number' ? args.maxRuns : null,
        // Remember where this task was created so a finished run can be reported back to the
        // same tab (or a stand-in for it) instead of vanishing into the scheduler's log only.
        creatorTabId: tab.id,
        creatorTabKind: tab.kind ?? 'project',
        creatorWorkspace: getWorkspace()
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
    case 'browser':
      return browserTool(args, {
        ownerId: tab.id,
        unattended,
        settings: browserAutomation ?? DEFAULT_BROWSER_AUTOMATION,
        onProgress: onToolProgress,
        signal
      })
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
    case 'multi_edit': {
      const normalized = normalizeEditsArg(args.edits)
      const edits = normalized.ok ? (normalized.edits as Array<{ path?: unknown }>) : []
      const paths = [...new Set(edits.map((e) => (typeof e.path === 'string' ? e.path : '')).filter(Boolean))]
      return paths.length > 1 ? `Editing ${paths.length} files` : `Editing ${paths[0] ?? 'files'}`
    }
    case 'delete_file':
      return `Deleting ${str(args.path) ?? 'file'}`
    case 'grep':
      return `Searching for "${str(args.pattern) ?? ''}"`
    case 'glob':
      return `Finding files matching "${str(args.pattern) ?? ''}"`
    case 'run_command':
      return `Running: ${str(args.command) ?? 'command'}`
    case 'read_terminal':
      return 'Reading terminal log'
    case 'web_search':
      return `Searching the web for "${str(args.query) ?? ''}"`
    case 'fetch_url':
      return `Fetching ${str(args.url) ?? 'url'}`
    case 'list_skills':
      return 'Listing skills'
    case 'read_skill':
      return `Reading skill ${str(args.path) ?? ''}`
    case 'read_memory':
      return args.scope === 'assistant' ? 'Reading assistant memory digest' : `Reading memory "${str(args.topic) ?? ''}"`
    case 'write_memory':
      return `Writing memory "${str(args.topic) ?? ''}"`
    case 'write_skill':
      return `Writing skill "${str(args.name) ?? ''}"`
    case 'write_subagent':
      return `Writing subagent "${str(args.name) ?? ''}"`
    case 'read_subagent':
      return `Reading subagent "${str(args.name) ?? ''}"`
    case 'ask_question':
      return 'Asking a clarifying question'
    case 'codebase_search':
      return `Searching codebase for "${str(args.query) ?? ''}"`
    case 'list_projects':
      return 'Listing other known projects'
    case 'list_memory':
      return `Listing ${str(args.scope) ?? 'project'} memory${args.project ? ` for ${str(args.project)}` : ''}`
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
    case 'browser': {
      const browserAction = str(args.action) ?? 'browse'
      const target = str(args.url) ?? (str(args.ref) ? `element ${str(args.ref)}` : undefined)
      return `Browser: ${browserAction}${target ? ` (${target})` : ''}`
    }
    default:
      return `Running ${toolName}`
  }
}

export async function runSubagent(
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
    startedAt: Date.now(),
    totalCostUsd: 0,
    totalSavingsUsd: 0
  }
  emit({ type: 'subagent_update', tabId: parentTab.id, run })

  const subTab: TabSession = {
    id: `sub_${run.id}`,
    title: `Sub: ${agentType}`,
    mode: 'agent',
    model: typeDef.model ?? defaultSubModel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // Inherit the parent tab's kind so a subagent spawned from an Assistant-kind tab is itself
    // treated as Assistant-kind for tool gating (getToolDefinitions()'s hasWorkspace check keys
    // off tab.kind !== 'assistant'). Without this, subTab.kind defaulted to undefined, which
    // satisfies `!== 'assistant'` and — combined with getWorkspace() being a process-global
    // singleton that's often truthy because some other window has a project open — let subagents
    // dispatched from Assistant tabs silently gain full coding-tool access (read/write/edit/
    // delete files, run_command, etc.) that the parent tab itself never had. See "Coding tools
    // available inside an Assistant-kind tab" investigation/fix.
    kind: parentTab.kind,
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

    // Keep the run's cost totals current (live, not just at the end) so the Subagents panel
    // can show cost-so-far for a still-running subagent, mirroring the main chat's spend display.
    let updated = false
    if (e.type === 'spend_update' && e.tabId === subTab.id) {
      run.totalCostUsd = e.totalCostUsd
      run.totalSavingsUsd = e.totalSavingsUsd
      updated = true
    }

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
      updated = true
    }
    if (updated) {
      emit({ type: 'subagent_update', tabId: parentTab.id, run })
    }
  }

  const subagentCtx: SubagentContext = { allowedTools: typeDef.tools, agentType, body: typeDef.body }

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
    // Safety net: sync from subTab directly in case the final usage chunk's spend_update event
    // hasn't been processed above for whatever reason, so the final cost shown is never stale.
    run.totalCostUsd = subTab.totalCostUsd
    run.totalSavingsUsd = subTab.totalSavingsUsd ?? 0
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
    run.totalCostUsd = subTab.totalCostUsd
    run.totalSavingsUsd = subTab.totalSavingsUsd ?? 0
    emit({ type: 'subagent_update', tabId: parentTab.id, run })
    emit({ type: 'turn_end', tabId: subTab.id })
    return { ok: false, summary: run.summary, error: 'subagent_error' }
  } finally {
    // Ephemeral per-run session — dispose it whether the subagent finished, errored, or was
    // aborted, so a subagent that used the browser tool never leaves a Chromium process behind.
    void disposeBrowserSession(subTab.id).catch(() => {})
  }
}
