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
import { getWorkspace } from '../workspace'
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
import { isIndexActive, searchCode } from './codeindex/manager'
import {
  MAX_SUBAGENT_DEPTH,
  MAX_TRUNCATION_RETRIES,
  DEFAULT_MAX_COMPLETION_TOKENS,
  checkStepLimit,
  isSubagentBudgetExceeded,
  isTruncatedEmpty,
  isTruncatedToolCallJson
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
  signal: AbortSignal
): Promise<void> {
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
    abortControllers.delete(tab.id)
    endedTurns.delete(tab.id)
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

  const userBlocks: ContentBlock[] = [{ type: 'text', text: userText }]
  if (images?.length) {
    for (const img of images) userBlocks.push({ type: 'image', dataUrl: img })
  }
  const userMsg: ChatMessage = { id: nanoid(), role: 'user', blocks: userBlocks, createdAt: Date.now() }
  tab.messages.push(userMsg)
  if (tab.title === 'New chat') tab.title = userText.slice(0, 40)
  await sessionStore.updateTab(tab)
  emitToAll({ type: 'user_message', tabId, message: userMsg })

  const ac = new AbortController()
  abortControllers.set(tabId, ac)
  endedTurns.delete(tabId)

  await startAgentLoop(tab, apiKey, settings.subagentModel, emitToAll, ac.signal)
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

  const ac = new AbortController()
  abortControllers.set(tabId, ac)
  endedTurns.delete(tabId)

  await startAgentLoop(tab, apiKey, settings.subagentModel, emitToAll, ac.signal)
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
    // level's approvals/questions, and it would risk runaway recursion.
    tools: getToolDefinitions(tab.mode, subagentCtx?.allowedTools, isIndexActive()).filter(
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
    default:
      return { ok: false, summary: `Unknown tool ${name}`, error: 'unknown' }
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
  const capture = (e: AgentStreamEvent) => {
    events.push(e)
    emit(e)
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
    run.summary = summary.slice(0, 8000)
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
    run.finishedAt = Date.now()
    emit({ type: 'subagent_update', tabId: parentTab.id, run })
    emit({ type: 'turn_end', tabId: subTab.id })
    return { ok: false, summary: run.summary, error: 'subagent_error' }
  }
}

async function buildSystemPrompt(mode: 'agent' | 'plan', shellId?: string | null): Promise<string> {
  const ws = getWorkspace()
  const [projMem, globalMem, autoMem, skills, subagents] = await Promise.all([
    loadProjectMemory(),
    loadGlobalMemory(),
    loadAutoMemoryIndex(),
    listSkills(),
    listSubagentTypes()
  ])

  const shell = resolveShell(shellId)

  const parts = [
    mode === 'plan' ? PLAN_MODE_PROMPT : AGENT_MODE_PROMPT,
    ws ? `Workspace: ${ws}` : 'No workspace open.',
    `run_command executes via ${shell.name} — write commands using that shell's syntax (quoting, path separators, env vars, chaining operators).`,
    projMem && `Project memory:\n${projMem}`,
    globalMem && `Global memory:\n${globalMem}`,
    autoMem && `Auto-memory index:\n${autoMem}`,
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
