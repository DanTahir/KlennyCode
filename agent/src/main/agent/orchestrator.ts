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
  ToolResultPayload
} from '@shared/types'
import { getApiKey, loadSettings } from '../settings'
import { getWorkspace } from '../workspace'
import { sessionStore } from '../session/store'
import { streamChatCompletion, fetchModels, type ChatMessage as ORMessage, type ToolCall } from '../openrouter/client'
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
import { loadProjectMemory, loadGlobalMemory, loadAutoMemoryIndex, writeMemory } from './memory/manager'
import { listSkills, readSkill, skillsCatalogPrompt } from './skills/manager'
import { listSubagentTypes, getSubagentType, subagentsCatalog } from './subagents/manager'
import { savePlan, AGENT_MODE_PROMPT, PLAN_MODE_PROMPT } from './plan/manager'
import { approvalManager } from './approval/manager'
import { maybeCompact } from './compaction/compactor'

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

async function agentLoop(
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  emit: Emit,
  signal: AbortSignal,
  depth = 0
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

  const compacted = await maybeCompact({ messages: tab.messages, model: modelInfo, apiKey, signal })
  if (compacted.compacted) {
    tab.messages = compacted.messages
    tab.compactedThroughMessageId = compacted.summaryMessageId
    await sessionStore.updateTab(tab)
    if (compacted.summaryMessageId) emit({ type: 'compaction', tabId: tab.id, summaryMessageId: compacted.summaryMessageId })
  }

  const systemPrompt = await buildSystemPrompt(tab.mode)
  const orMessages = toORMessages(tab.messages, systemPrompt)

  const assistantId = nanoid()
  const assistantMsg: ChatMessage = {
    id: assistantId,
    role: 'assistant',
    blocks: [],
    createdAt: Date.now()
  }
  tab.messages.push(assistantMsg)
  emit({ type: 'message_start', tabId: tab.id, message: assistantMsg })

  let textBuf = ''
  let thinkingBuf = ''
  const toolCallsById = new Map<string, ToolCall>()

  for await (const chunk of streamChatCompletion({
    apiKey,
    model: tab.model,
    messages: orMessages,
    tools: getToolDefinitions(tab.mode),
    signal,
    includeReasoning: modelInfo.supportsReasoning
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
      tab.totalCostUsd += chunk.usage.costUsd
      trackDailySpend(chunk.usage.costUsd)
      assistantMsg.usage = {
        promptTokens: chunk.usage.promptTokens,
        completionTokens: chunk.usage.completionTokens,
        costUsd: chunk.usage.costUsd
      }
      emit({ type: 'spend_update', tabId: tab.id, totalCostUsd: tab.totalCostUsd, capUsd: settings.spendingCapUsd })
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

  // Execute tools (parallel where independent)
  const results = await Promise.all(
    toolCalls.map((tc) =>
      executeTool(tc, tab, apiKey, subagentModel, settings.approvalMode, emit, signal, depth)
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

  await sessionStore.updateTab(tab)
  if (signal.aborted) return
  await agentLoop(tab, apiKey, subagentModel, emit, signal, depth + 1)
}

async function executeTool(
  tc: ToolCall,
  tab: TabSession,
  apiKey: string,
  subagentModel: string,
  approvalMode: 'manual' | 'auto',
  emit: Emit,
  signal: AbortSignal,
  depth: number
): Promise<{ payload: ToolResultPayload; status: ToolCallBlock['status'] }> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
  } catch {
    return { payload: { ok: false, summary: 'Invalid JSON args', error: 'parse' }, status: 'error' }
  }

  const name = tc.function.name

  if (name === 'ask_question') {
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
    const payload = await dispatchTool(name, args, tab, apiKey, subagentModel, emit, signal, depth)
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
  depth: number
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
      return runCommandTool(args as { command: string; cwd?: string; timeout_ms?: number }, signal)
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
    totalCostUsd: 0
  }

  const events: AgentStreamEvent[] = []
  const capture = (e: AgentStreamEvent) => events.push(e)

  try {
    await agentLoop(subTab, apiKey, defaultSubModel, capture, signal, depth + 1)
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

    if (!BrowserWindow.getFocusedWindow()) {
      new Notification({ title: 'Klenny subagent finished', body: `${agentType}: ${desc}` }).show()
    }

    return { ok: true, summary: run.summary, data: { run } }
  } catch (e) {
    run.status = 'error'
    run.summary = e instanceof Error ? e.message : String(e)
    run.finishedAt = Date.now()
    emit({ type: 'subagent_update', tabId: parentTab.id, run })
    return { ok: false, summary: run.summary, error: 'subagent_error' }
  }
}

async function buildSystemPrompt(mode: 'agent' | 'plan'): Promise<string> {
  const ws = getWorkspace()
  const [projMem, globalMem, autoMem, skills, subagents] = await Promise.all([
    loadProjectMemory(),
    loadGlobalMemory(),
    loadAutoMemoryIndex(),
    listSkills(),
    listSubagentTypes()
  ])

  const parts = [
    mode === 'plan' ? PLAN_MODE_PROMPT : AGENT_MODE_PROMPT,
    ws ? `Workspace: ${ws}` : 'No workspace open.',
    projMem && `Project memory:\n${projMem}`,
    globalMem && `Global memory:\n${globalMem}`,
    autoMem && `Auto-memory index:\n${autoMem}`,
    skillsCatalogPrompt(skills),
    `Subagents:\n${subagentsCatalog(subagents)}`
  ].filter(Boolean)

  return parts.join('\n\n')
}

function toORMessages(messages: ChatMessage[], systemPrompt: string): ORMessage[] {
  const out: ORMessage[] = [{ role: 'system', content: systemPrompt }]
  const sentToolResults = new Set<string>()
  for (const m of messages) {
    if (m.role === 'user') {
      const textParts = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
      const images = m.blocks.filter((b) => b.type === 'image') as Array<{ dataUrl: string }>
      if (images.length) {
        out.push({
          role: 'user',
          content: [
            ...textParts.map((t) => ({ type: 'text' as const, text: t })),
            ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } }))
          ]
        })
      } else {
        out.push({ role: 'user', content: textParts.join('\n') })
      }
    } else if (m.role === 'assistant') {
      const text = m.blocks
        .filter((b) => b.type === 'text' || b.type === 'thinking')
        .map((b) => (b as { text: string }).text)
        .join('')
      const tcs = [...new Map(
        (m.blocks.filter((b) => b.type === 'tool_call') as ToolCallBlock[]).map((tc) => [tc.id, tc])
      ).values()]
      if (tcs.length) {
        out.push({
          role: 'assistant',
          content: text || '',
          tool_calls: tcs.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.toolName, arguments: JSON.stringify(tc.args) }
          }))
        })
      } else if (text) {
        out.push({ role: 'assistant', content: text })
      }
    } else if (m.role === 'tool') {
      const tc = m.blocks.find((b) => b.type === 'tool_call') as ToolCallBlock | undefined
      if (tc?.result && !sentToolResults.has(tc.id)) {
        sentToolResults.add(tc.id)
        out.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: compactToolResult(tc.result)
        })
      }
    }
  }
  return out
}

function compactToolResult(result: ToolResultPayload): string {
  const compact: ToolResultPayload = { ...result, data: result.data ? { ...(result.data as object) } : undefined }
  const data = compact.data as Record<string, unknown> | undefined
  if (data && Array.isArray(data.hits) && data.hits.length > 40) {
    const total = data.hits.length
    data.hits = data.hits.slice(0, 40)
    data.truncated = true
    data.totalHits = total
    compact.summary = `${compact.summary} (first 40 of ${total})`
  }
  if (data && Array.isArray(data.files) && data.files.length > 100) {
    data.files = (data.files as string[]).slice(0, 100)
    data.truncated = true
  }
  let json = JSON.stringify(compact)
  if (json.length > 40_000) json = `${json.slice(0, 40_000)}…[truncated]`
  return json
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
    return { title: `Write ${path}`, extra: { filePath: path, diff: makeSimpleDiff('', String(args.content), path) } }
  }
  if (name === 'edit_file') {
    try {
      const r = await readFileTool({ path })
      const content = (r.data as { content?: string })?.content ?? ''
      const oldStr = String(args.old_string)
      const newStr = String(args.new_string)
      const updated = content.replace(oldStr, newStr)
      return { title: `Edit ${path}`, extra: { filePath: path, diff: makeSimpleDiff(content, updated, path) } }
    } catch {
      return { title: `Edit ${path}`, extra: { filePath: path } }
    }
  }
  return { title: `Delete ${path}`, extra: { filePath: path } }
}

function makeSimpleDiff(oldText: string, newText: string, path: string): string {
  return `--- a/${path}\n+++ b/${path}\n-${oldText}\n+${newText}`
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
