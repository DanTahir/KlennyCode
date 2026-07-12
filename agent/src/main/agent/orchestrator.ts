import { BrowserWindow, Notification } from 'electron'
import { nanoid } from 'nanoid'
import type {
  AgentStreamEvent,
  ChatMessage,
  ContentBlock,
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
  fetchUrlTool
} from './tools/index'
import { loadProjectMemory, loadGlobalMemory, loadAutoMemoryIndex, writeMemory, readMemoryTopic } from './memory/manager'
import { listSkills, readSkill, skillsCatalogPrompt } from './skills/manager'
import { listSubagentTypes, getSubagentType, subagentsCatalog } from './subagents/manager'
import { savePlan, AGENT_MODE_PROMPT, PLAN_MODE_PROMPT } from './plan/manager'
import { approvalManager } from './approval/manager'
import { maybeCompact } from './compaction/compactor'
import { makeDiff } from './tools/diff'
import { findNewlySupersededBlocks } from './collapsing'
import { resolveReasoningEffort } from './reasoning'
import { toORMessages } from './messages'

type Emit = (event: AgentStreamEvent) => void

const abortControllers = new Map<string, AbortController>()
const questionWaiters = new Map<string, (answers: QuestionAnswer[]) => void>()
const pendingQuestions = new Map<string, PendingQuestion>()
const endedTurns = new Set<string>()

let dailySpend = 0
let dailySpendDate = new Date().toDateString()

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

  try {
    await agentLoop(tab, apiKey, settings.subagentModel, emitToAll, ac.signal)
  } catch (e) {
    if (!ac.signal.aborted) {
      emitToAll({
        type: 'error',
        tabId,
        message: e instanceof Error ? e.message : String(e)
      })
    }
  } finally {
    endTurn(tabId)
    abortControllers.delete(tabId)
    endedTurns.delete(tabId)
  }
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
  depth = 0,
  subagentCtx?: SubagentContext
): Promise<void> {
  if (depth > 30) return
  throwIfAborted(signal)

  const settings = await loadSettings()
  const models = await fetchModels(apiKey, false, signal)
  const modelInfo = models.find((m) => m.id === tab.model) ?? models[0]
  if (!modelInfo) {
    emit({ type: 'error', tabId: tab.id, message: 'Model not found.' })
    return
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
  const orMessages = toORMessages(tab.messages, systemPrompt, settings.collapseSupersededResultsEnabled)

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
    tools: getToolDefinitions(tab.mode, subagentCtx?.allowedTools).filter(
      (t) => !subagentCtx || t.function.name !== 'task'
    ),
    signal,
    reasoningEffort: supportsGranularEffort ? reasoningEffort : undefined,
    reasoningEnabledOnly,
    sessionId: tab.id,
    providerPreference: settings.providerPreference,
    supportsExplicitCaching,
    includeLastMessageCacheBreakpoint
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
      return
    }
  }

  if (signal.aborted) return

  const toolCalls = [...toolCallsById.values()]

  if (thinkingBuf) assistantMsg.blocks.push({ type: 'thinking', text: thinkingBuf })
  if (textBuf) assistantMsg.blocks.push({ type: 'text', text: textBuf })

  if (!toolCalls.length) {
    emit({ type: 'message_end', tabId: tab.id, messageId: assistantId, usage: assistantMsg.usage })
    await sessionStore.updateTab(tab)
    return
  }

  // Record assistant tool calls in message
  for (const tc of toolCalls) {
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
    } catch {
      args = {}
    }
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

  if (signal.aborted) return

  // Execute tools (parallel where independent).
  // Subagents run headless (no UI to answer approvals/questions), so force
  // auto-approval for their mutating tool calls to avoid deadlocking forever.
  const effectiveApprovalMode = subagentCtx ? 'auto' : settings.approvalMode
  const results = await Promise.all(
    toolCalls.map((tc) =>
      executeTool(tc, tab, apiKey, subagentModel, effectiveApprovalMode, emit, signal, depth, subagentCtx, settings.shellId)
    )
  )

  if (signal.aborted) return

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

  // Detect any older tool results that this turn's tool calls have made stale (same file
  // path / grep query / URL read or modified again) and annotate them with a short stub —
  // never touching the original `result` — so subsequent turns send less to the model.
  // Each tool call has two block copies in tab.messages (one on the assistant message with
  // the real args, one on the paired tool-role message used for the OpenRouter request) —
  // both need the annotation: the assistant copy is what the UI/badge reads, the tool-role
  // copy is what toORMessages reads when building the model-facing request.
  if (settings.collapseSupersededResultsEnabled) {
    const superseded = findNewlySupersededBlocks(tab.messages)
    for (const { toolCallId, stub } of superseded) {
      for (const msg of tab.messages) {
        const blk = msg.blocks.find((b) => b.type === 'tool_call' && (b as ToolCallBlock).id === toolCallId) as
          | ToolCallBlock
          | undefined
        if (blk && !blk.supersededSummary) {
          blk.supersededSummary = stub
          emit({ type: 'tool_call_superseded', tabId: tab.id, messageId: msg.id, toolCallId, supersededSummary: stub })
        }
      }
    }
  }

  await sessionStore.updateTab(tab)
  if (signal.aborted) return
  await agentLoop(tab, apiKey, subagentModel, emit, signal, depth + 1, subagentCtx)
}

async function executeTool(
  tc: ToolCall,
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  approvalMode: 'manual' | 'auto',
  emit: Emit,
  signal: AbortSignal,
  depth: number,
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
    const payload = await dispatchTool(name, args, tab, apiKey, subagentModel, emit, signal, depth, shellId)
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
  depth: number,
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
      return grepTool(args as { pattern: string; path?: string; glob?: string; case_insensitive?: boolean }, signal)
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
      return runSubagent(tab, apiKey, subagentModel, args, emit, signal, depth)
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
  depth: number
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
    await agentLoop(subTab, apiKey, defaultSubModel, capture, signal, depth + 1, subagentCtx)
    const summary =
      subTab.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n') || 'Subagent completed with no text output.'

    run.status = 'success'
    run.summary = summary.slice(0, 8000)
    run.finishedAt = Date.now()
    emit({ type: 'subagent_update', tabId: parentTab.id, run })
    emit({ type: 'turn_end', tabId: subTab.id })

    if (!BrowserWindow.getFocusedWindow()) {
      new Notification({ title: 'Klenny Code subagent finished', body: `${agentType}: ${desc}` }).show()
    }

    return { ok: true, summary: run.summary, data: { run } }
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
    return { title: `Write ${path}`, extra: { filePath: path, diff: makeDiff('', String(args.content), path) } }
  }
  if (name === 'edit_file') {
    try {
      const r = await readFileTool({ path })
      const content = (r.data as { content?: string })?.content ?? ''
      const oldStr = String(args.old_string)
      const newStr = String(args.new_string)
      const updated = content.replace(oldStr, newStr)
      return { title: `Edit ${path}`, extra: { filePath: path, diff: makeDiff(content, updated, path) } }
    } catch {
      return { title: `Edit ${path}`, extra: { filePath: path } }
    }
  }
  return { title: `Delete ${path}`, extra: { filePath: path } }
}

function checkSpendCap(tab: TabSession, cap: number | null, period: 'session' | 'daily'): void {
  if (!cap) return
  const spend = period === 'daily' ? dailySpend : tab.totalCostUsd
  if (spend >= cap) {
    emitToAll({ type: 'spend_blocked', tabId: tab.id })
    throw new Error('Spending cap exceeded')
  }
}

function trackDailySpend(cost: number): void {
  const today = new Date().toDateString()
  if (today !== dailySpendDate) {
    dailySpendDate = today
    dailySpend = 0
  }
  dailySpend += cost
}

export function getPendingQuestions(): PendingQuestion[] {
  return [...pendingQuestions.values()]
}
