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
  ChecklistBlock,
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
import { DEFAULT_BROWSER_AUTOMATION, CODING_ONLY_TOOLS, DOCX_TOOLS, ALWAYS_BLOCKED_TOOLS } from '@shared/types'
import { shouldEmitWriting, sniffWritingTarget } from '@shared/toolWriting'
import { loadSettings } from '../../settings'
import { resolveDocumentsDirectory } from '../../documentsDir'
import { globalKlennyDir, userDataDir } from '../../dataDir'
import { getWorkspace } from '../../workspace'
import { sessionStore } from '../../session/store'
import {
  streamChatCompletion,
  fetchModels,
  type ToolCall,
  type ReasoningDetail,
  // Aliased: loop.ts's own `ChatMessage` is the app-level message type from @shared/types, while
  // this is the OpenRouter wire shape that streamChatCompletion actually takes.
  type ChatMessage as ORChatMessage
} from '../../openrouter/client'
import {
  modelSupportsCaching,
  computeCacheSavings,
  shouldPrimeCache,
  estimatePrefixTokens,
  hashPrefix,
  notePrefixSent,
  prefixLastSentAt,
  markCachePrimingIneffective,
  isCachePrimingIneffective,
  primingLookedIneffective
} from '../../openrouter/caching'
import { getToolDefinitions } from '../tools/definitions'
import {
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditFileTool,
  normalizeEditsArg,
  type MultiEditOp,
  multiWriteFileTool,
  normalizeFilesArg,
  deleteFileTool,
  grepTool,
  globTool,
  runCommandTool,
  readTerminalTool,
  readAppLogTool,
  webSearchTool,
  fetchUrlTool,
  readImageTool,
  generateImageTool,
  type GenerateImageToolArgs,
  parallelWriteTool,
  type WorkerRequest,
  type JobApprovalRequest
} from '../tools/index'
import { browserTool, isBrowserActionMutating, buildBrowserApprovalPreview } from '../tools/browser'
import { disposeSession as disposeBrowserSession } from '../../browser/manager'
import { readDocxTool, writeDocxTool, editDocxTool } from '../docx/index'
import { listProjectsTool, resolveProjectOrError } from '../tools/otherProjects'
import { writeMemory, readMemoryTopic, loadProjectMemory, loadAutoMemoryIndex, loadGlobalMemory, listMemoryTopics } from '../memory/manager'
import { buildFullAssistantMemoryDigest } from '../memory/assistantMemory'
import { listSkills, readSkillDetailed, writeSkill } from '../skills/manager'
import { getSubagentType, writeSubagentType } from '../subagents/manager'
import { savePlan } from '../plan/manager'
import { buildChecklist } from './checklist'
import { buildTurnLedger, buildLedgerDigest, turnHasSubstantiveToolCall } from './ledger'
import {
  auditAssistantMessage,
  buildAuditNoteMessage,
  buildFindingsWarningBlock,
  MAX_AUDIT_CORRECTIONS,
  type AuditOutcome
} from '../verify/audit'
import type { DetectorContextKind } from '../verify/fabrication-detector'
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
import { createPawprint, updatePawprint, readPawprintSource } from '../pawprints/manager'
import {
  MAX_SUBAGENT_DEPTH,
  MAX_TRUNCATION_RETRIES,
  DEFAULT_MAX_COMPLETION_TOKENS,
  checkStepLimit,
  isSubagentBudgetExceeded,
  isEmptyGeneration,
  classifyToolCallJsonFailure,
  looksLikeTruncatedJson,
  describeToolArgsFailure,
  buildToolArgsRetryNudge,
  shouldResumeAfterCompaction,
  buildCompactionResumeNudge,
  shouldResumeAfterAuditCorrection,
  buildAuditResumeNudge,
  truncateSummary
} from '../turnControl'
import { buildSystemPrompt, buildCurrentTimeNote } from './system-prompt'
import { previewMutatingTool, checkSpendCap } from './approval-previews'
import {
  type Emit,
  type LoopStopReason,
  type SubagentContext,
  throwIfAborted,
  pendingQuestions,
  questionWaiters
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
  truncationRetries = 0,
  /** How many forced fabrication-guard self-correction turns have already happened in this turn.
   *  Bounded by MAX_AUDIT_CORRECTIONS so a model that won't retract can't loop forever. */
  auditCorrections = 0,
  /** How many times this turn has already been auto-resumed after a step on which compaction ran
   *  ended with no tool calls (see shouldResumeAfterCompaction). Must be carried across the
   *  recursion explicitly: `maybeCompact` returns `compacted: false` on the resumed step, so
   *  "compaction fired here" is not re-derivable after the fact. */
  compactionResumes = 0,
  /** How many times this turn has already been auto-resumed after a fabrication-guard correction
   *  turn ended with no tool calls (see shouldResumeAfterAuditCorrection). Carried across the
   *  recursion for the same reason as compactionResumes. */
  auditResumes = 0
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
  // Deliberately does NOT fall back to models[0] when tab.model isn't in the fetched list —
  // that used to silently compute reasoning-effort/caching decisions (see resolveReasoningEffort/
  // supportsExplicitCaching below) against a DIFFERENT model than the one actually sent on the
  // wire, while looking to the user like their model choice was silently ignored.
  const modelInfo = models.find((m) => m.id === tab.model)
  if (!modelInfo) {
    emit({ type: 'error', tabId: tab.id, message: `Model "${tab.model}" not found — it may no longer be available on OpenRouter. Pick a different model for this tab.` })
    return 'error'
  }

  // Compaction can take many seconds (a whole summarization round-trip) while emitting nothing
  // else, so bracket it with start/end events that drive the "Compacting context" indicator.
  // `.finally` (rather than try/finally around the assignment) keeps `compacted` a const and
  // still fires on the throw/abort path.
  let compactionStarted = false
  const compacted = await maybeCompact({
    messages: tab.messages,
    model: modelInfo,
    apiKey,
    signal,
    promptCachingEnabled: settings.promptCachingEnabled,
    utilityModel: settings.utilityModel,
    models,
    priorSummary: tab.compactionSummary,
    priorCompactedThroughMessageId: tab.compactedThroughMessageId,
    activePlan: tab.activePlan,
    onCompactionStart: () => {
      compactionStarted = true
      emit({ type: 'compaction_start', tabId: tab.id })
    }
  }).finally(() => {
    if (compactionStarted) emit({ type: 'compaction_end', tabId: tab.id })
  })
  if (compacted.compacted && compacted.summary && compacted.compactedThroughMessageId) {
    // `tab.messages` (the UI-facing history) is left completely untouched here — only these two
    // fields change, and they're consulted below (via `messagesForWire`/`toORMessages`) purely
    // to shrink what's sent to the model, not what the user sees in the chat.
    tab.compactionSummary = compacted.summary
    tab.compactedThroughMessageId = compacted.compactedThroughMessageId
    await sessionStore.updateTab(tab)
    emit({
      type: 'compaction',
      tabId: tab.id,
      compactedThroughMessageId: compacted.compactedThroughMessageId,
      summary: compacted.summary
    })
  }

  // How much of the live checklist is still outstanding. Read here (rather than at the exit that
  // uses it) so the diagnostic below and the post-compaction resume decision see the same value.
  const unfinishedChecklistItems = tab.activeChecklist?.items.filter((it) => !it.done).length ?? 0
  const nextUnfinishedChecklistItem = tab.activeChecklist?.items.find((it) => !it.done)?.text

  // Logged on EVERY step, not just when compaction fires, and deliberately including the name of
  // the preceding tool call. The post-compaction stall was observed three times in one session,
  // every time immediately after an `update_checklist` call at a phase boundary, and two readings
  // were left unresolved: either phase boundaries are simply the token-heaviest moments (benign
  // correlation), or a "milestone closed" transcript shape genuinely makes the next reply more
  // likely to be text-only. These four numbers together settle it from real logs instead of
  // another anecdote: if compaction clusters on post-update_checklist steps at token counts where
  // other steps don't compact, that's aggravation; if it tracks tokenEstimate alone, it's benign.
  console.log(
    `[compaction] step=${stepCount} tokens~${compacted.tokenEstimate} threshold=${Math.round(compacted.threshold)} fired=${compacted.compacted} prevTool=${lastToolCallName(tab.messages) ?? 'none'} unfinishedChecklist=${unfinishedChecklistItems} resumes=${compactionResumes}`
  )

  const systemPrompt = await buildSystemPrompt(
    tab.mode,
    settings.shellId,
    subagentCtx,
    tab.kind === 'assistant' ? 'assistant' : 'project',
    // Mirrors exactly the gating passed to getToolDefinitions() below, so the Assistant-tab
    // prompt text never names a docx/Gmail/Discord tool the schema doesn't actually include.
    // (docx has no coding-toggle gate here since it's only relevant for kind === 'assistant',
    // where docx tools are always on regardless of docxAvailableInCoding — that setting only
    // gates docx tools on project tabs.)
    {
      docx: true,
      gmailRead: Boolean(settings.hasGmailToken) && settings.automationPermissions['gmail.read'] === 'auto',
      gmailSend: Boolean(settings.hasGmailToken) && settings.automationPermissions['gmail.send'] === 'auto',
      discord: Boolean(settings.hasDiscordToken) && settings.automationPermissions['discord.post'] === 'auto',
      browser: (settings.browserAutomation?.policy ?? 'off') !== 'off'
    }
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
  // Provider-structured reasoning for this turn, captured so it can be replayed on later turns to
  // preserve reasoning continuity across tool calls (see ChatMessage.reasoningDetails).
  let streamedReasoningDetails: ReasoningDetail[] | undefined
  const toolCallsById = new Map<string, ToolCall>()
  // Live "writing…" bookkeeping for tool calls whose arguments are still streaming, keyed by the
  // provider's delta index. Purely cosmetic and never persisted — the authoritative calls come
  // from the end-of-stream 'tool_calls' chunk into toolCallsById above.
  const writingByIndex = new Map<
    number,
    { id: string; name: string; args: string; lastEmitAt: number; lastEmitChars: number }
  >()

  // Skip the "last message" cache breakpoint on the very first request of a
  // conversation/subagent run, since there's nothing yet to read back from a cache write
  // and we'd only pay the cache-write premium for no benefit.
  const includeLastMessageCacheBreakpoint = tab.messages.some((m) => m.id !== assistantId && m.usage)
  const supportsExplicitCaching =
    settings.promptCachingEnabled && modelInfo.supportsExplicitCaching && modelSupportsCaching(modelInfo)
  // NOTE: this request's breakpoint index is deliberately NOT tracked for re-marking next
  // request. That "insurance" re-mark was the root cause of the newest cache block never being
  // read back: a cache_control marker interior to a cached prefix is part of that prefix's
  // identity upstream, so a marker present at write time and absent at read time invalidates the
  // block. See applyCacheControl's doc comment in openrouter/caching.ts for the measured
  // `[cache]` ladder (r1-r4) and the proof that implicit lookback finds the prefix unaided.

  // Subagents can't spawn nested subagents — there's no UI to surface a deeper
  // level's approvals/questions, and it would risk runaway recursion. The ephemeral Assistant
  // tab gets its own fixed ASSISTANT_TOOLS allow-set (file tools included, scoped to
  // documentsDirectory below, but no run_command/read_terminal/codebase_search/save_plan);
  // other tabs hide workspace-only tools whenever no project is open.
  // Hoisted out of the streamChatCompletion() call below so the fabrication guard can reuse the
  // exact same tool list as `knownToolNames` — deriving it from a second, hand-maintained list
  // would let the two drift apart silently.
  const toolDefs = getToolDefinitions(
    tab.mode,
    subagentCtx?.allowedTools,
    isIndexActive(),
    Boolean(getWorkspace()),
    tab.kind === 'assistant',
    {
      docxAvailableInCoding: settings.docxAvailableInCoding,
      gmailConnected: settings.hasGmailToken,
      gmailReadAllowed: settings.automationPermissions['gmail.read'] === 'auto',
      gmailSendAllowed: settings.automationPermissions['gmail.send'] === 'auto',
      gmailAvailableInCoding: settings.gmailAvailableInCoding,
      discordConnected: settings.hasDiscordToken,
      discordPostAllowed: settings.automationPermissions['discord.post'] === 'auto',
      discordAvailableInCoding: settings.discordAvailableInCoding,
      browserAutomationAvailable: (settings.browserAutomation?.policy ?? 'off') !== 'off',
      imageGenerationAvailable: settings.imageModel != null
    }
    // NB: nothing per-turn is passed here on purpose. This array is the request's `tools` block,
    // which a provider hashes ahead of the system prompt, so anything conversation-state-derived
    // (this used to pass Boolean(tab.activeChecklist)) invalidates the whole cached prefix the
    // moment it flips. See the update_checklist comment in tools/definitions.ts.
  ).filter((t) => !subagentCtx || t.function.name !== 'task')
  const knownToolNames = toolDefs.map((t) => t.function.name)

  for await (const chunk of streamChatCompletion({
    apiKey,
    model: tab.model,
    messages: orMessages,
    tools: toolDefs,
    signal,
    reasoningEffort: supportsGranularEffort ? reasoningEffort : undefined,
    reasoningEnabledOnly,
    sessionId: tab.id,
    providerPreference: settings.providerPreference,
    supportsExplicitCaching,
    includeLastMessageCacheBreakpoint,
    maxTokens: modelInfo.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS,
    currentTimeNote: await buildCurrentTimeNote(
      tab.kind === 'assistant' ? tab.id : undefined,
      tab.activeChecklist,
      compacted.compacted,
      // Verification ledger for the turn so far. Computed here, per step, so it grows as the turn
      // executes tools — by design this is the model-facing copy only; the fabrication detector
      // recomputes its own ledger AFTER streaming so it also sees the calls made by the very
      // message being audited (a pre-call snapshot would flag the first legitimate use of any
      // tool in a turn). The empty assistantMsg pushed just above contributes nothing yet.
      buildLedgerDigest(buildTurnLedger(tab.messages))
    )
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
    if (chunk.type === 'tool_call_delta' && chunk.toolCallDelta) {
      const d = chunk.toolCallDelta
      const w =
        writingByIndex.get(d.index) ??
        { id: d.id, name: '', args: '', lastEmitAt: 0, lastEmitChars: -1 }
      w.id = d.id
      if (d.name) w.name += d.name
      if (d.argsDelta) w.args += d.argsDelta
      writingByIndex.set(d.index, w)
      const now = Date.now()
      if (
        shouldEmitWriting({
          now,
          lastEmitAt: w.lastEmitAt,
          charsSoFar: w.args.length,
          lastEmitChars: w.lastEmitChars
        })
      ) {
        w.lastEmitAt = now
        w.lastEmitChars = w.args.length
        emit({
          type: 'tool_call_writing',
          tabId: tab.id,
          messageId: assistantId,
          toolCallId: w.id,
          toolName: w.name,
          charsSoFar: w.args.length,
          label: sniffWritingTarget(w.name, w.args)
        })
      }
    }
    if (chunk.type === 'tool_calls' && chunk.toolCalls) {
      for (const tc of chunk.toolCalls) toolCallsById.set(tc.id, tc)
    }
    if (chunk.type === 'done') {
      // Checked independently of finishReason: the reasoning payload rides the same 'done' chunk
      // but a stream can finish without a finish_reason, and we still want the reasoning.
      if (chunk.finishReason) finishReason = chunk.finishReason
      if (chunk.reasoningDetails?.length) streamedReasoningDetails = chunk.reasoningDetails
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
  const unparsableToolNames: string[] = []
  for (const tc of toolCalls) {
    try {
      parsedArgsByCallId.set(tc.id, JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>)
    } catch (e) {
      // Diagnostics for the multi_write/multi_edit "it just fails sometimes" failure mode: without
      // the arg length, the finish_reason and the tail, this is indistinguishable from a tool bug.
      // Pairs with the `[stream] end` line in openrouter/client.ts, which reports whether the SSE
      // [DONE] sentinel ever arrived (i.e. whether the stream was cut rather than capped).
      const raw = tc.function.arguments ?? ''
      console.error(
        `[toolargs] unparsable model=${tab.model} tool=${tc.function.name} chars=${raw.length} ` +
          `finishReason=${finishReason ?? 'none'} looksTruncated=${looksLikeTruncatedJson(raw)} ` +
          `err=${e instanceof Error ? e.message : String(e)} tail=${JSON.stringify(raw.slice(-80))}`
      )
      unparsableToolNames.push(tc.function.name)
      parsedArgsByCallId.set(tc.id, {})
    }
  }
  const anyArgsUnparsable = unparsableToolNames.length > 0

  // The ThinkingBlock is for the UI; reasoningDetails is the wire-faithful copy replayed to the
  // provider on later turns. Both are recorded, and neither is ever merged into message content.
  if (thinkingBuf) assistantMsg.blocks.push({ type: 'thinking', text: thinkingBuf })
  if (textBuf) assistantMsg.blocks.push({ type: 'text', text: textBuf })
  if (streamedReasoningDetails?.length) assistantMsg.reasoningDetails = streamedReasoningDetails

  // ---- Fabrication guard ---------------------------------------------------------------------
  // Cross-checks what this message CLAIMS against the harness's own execution records. Runs only
  // after the blocks above are attached, and after any tool_call blocks are recorded further
  // down, so the ledger it builds includes this very message's calls.
  const fabricationGuard = settings.fabricationGuard ?? 'enforce'
  const auditContextKind: DetectorContextKind = subagentCtx
    ? 'subagent'
    : tab.kind === 'assistant'
      ? 'assistant'
      : tab.mode === 'plan'
        ? 'plan'
        : 'project-agent'

  const runAudit = async (): Promise<AuditOutcome> => {
    // Artifact claims are resolved against the same root the tab's own file tools use, so a
    // relative path in prose is checked exactly where a write would have landed.
    const auditRoot =
      tab.kind === 'assistant' ? await resolveDocumentsDirectory() : (getWorkspace() ?? undefined)
    // The agent legitimately reads and discusses its own config/memory files, which live outside
    // the workspace entirely. Resolving a bare filename like "settings.json" against the workspace
    // alone made a truthful mention of a real file look like a fabricated artifact.
    const auditExtraRoots = [userDataDir(), globalKlennyDir()]
    const outcome = auditAssistantMessage({
      assistantMsg,
      messages: tab.messages,
      guard: fabricationGuard,
      contextKind: auditContextKind,
      root: auditRoot,
      extraRoots: auditExtraRoots,
      activeChecklist: tab.activeChecklist,
      knownToolNames
    })
    if (outcome.status !== 'clean') {
      // Flag the message rather than altering it: the user must still see what was claimed.
      assistantMsg.verification = { status: outcome.status, findings: outcome.findings }
      emit({
        type: 'fabrication_flagged',
        tabId: tab.id,
        messageId: assistantId,
        status: outcome.status,
        findings: outcome.findings,
        forcedCorrection: outcome.forceCorrection && !subagentCtx
      })
    }
    return outcome
  }

  /**
   * Turns a disputed verdict into an actual consequence.
   *  'none'         — nothing to do (clean, soft-only, 'warn' mode, or a subagent/scheduled run,
   *                   where findings are surfaced in the returned summary instead of looped on).
   *  'correct'      — an audit note was injected; caller should recurse for a correction turn.
   *  'audit_failed' — the correction budget is exhausted; caller should stop.
   */
  const applyAuditEnforcement = async (
    outcome: AuditOutcome
  ): Promise<'none' | 'correct' | 'audit_failed'> => {
    if (!outcome.forceCorrection) return 'none'
    // A subagent has no UI to click Continue and a fixed step budget; a scheduled run is one-shot.
    // Forcing corrections there would burn the budget without a human ever seeing the exchange.
    if (subagentCtx) return 'none'
    if (auditCorrections + 1 > MAX_AUDIT_CORRECTIONS) {
      emit({
        type: 'error',
        tabId: tab.id,
        message:
          'The fabrication guard flagged unsupported claims repeatedly and the model did not produce a corrected, evidence-backed response. Stopping rather than continuing — review the disputed messages above; the work they describe may not have actually happened.'
      })
      return 'audit_failed'
    }
    tab.messages.push(buildAuditNoteMessage(outcome))
    await sessionStore.updateTab(tab)
    return 'correct'
  }

  // A generation that produced nothing at all used to look identical to a normal "model is done"
  // stop (no tool calls, or tool calls whose arguments failed to parse and then died on an opaque
  // 'Invalid JSON args') — silently ending the turn or failing tools with a confusing error.
  // Detect it and retry instead, up to MAX_TRUNCATION_RETRIES.
  //
  // NEITHER arm is gated on finishReason === 'length' any more, and that is the whole point in
  // both cases: the provider's stop label is unreliable. See classifyToolCallJsonFailure for the
  // args arm, and isEmptyGeneration for the empty arm — the latter's gate is what let a
  // content-free generation labelled 'stop' (or carrying no finish_reason at all) fall through to
  // the `!toolCalls.length` exit below and end the turn as a clean 'natural' completion, which is
  // the "the job kept stopping" stall: no text, no tool call, no error, nothing to click.
  const argsFailure = classifyToolCallJsonFailure(finishReason, anyArgsUnparsable)
  const emptyGeneration = isEmptyGeneration(toolCalls.length > 0, Boolean(textBuf))
  if (emptyGeneration || argsFailure !== 'none') {
    emit({ type: 'message_end', tabId: tab.id, messageId: assistantId, usage: assistantMsg.usage })
    await sessionStore.updateTab(tab)
    if (signal.aborted) return 'aborted'

    if (truncationRetries + 1 > MAX_TRUNCATION_RETRIES) {
      emit({
        type: 'error',
        tabId: tab.id,
        // Worded per arm: blaming the output token limit for an empty generation would assert a
        // cause the provider never reported. Either way this is now a VISIBLE failure rather than
        // a silent 'natural' end of turn, which is the actual user-facing bug being fixed.
        message:
          argsFailure !== 'none'
            ? 'The model repeatedly cut its response off at the output token limit and retrying did not recover. Try again, or switch to a model with a larger output limit.'
            : 'The model repeatedly returned an empty response — no text and no tool calls — and retrying did not recover. That is usually a provider-side problem: try again, or switch to a different model.'
      })
      // Surface findings for visibility, but never force a correction here: the context is
      // already broken by truncation, so a mid-sentence claim isn't evidence of fabrication.
      await runAudit()
      await sessionStore.updateTab(tab)
      return 'truncation_failed'
    }
    // Discard this attempt's (possibly garbage) tool calls entirely rather than dispatching
    // them, and re-issue. Doesn't count as a new step — it's a retry of the same one.
    //
    // The re-issued request is deliberately NOT byte-identical to the one that just failed: a
    // harness-authored nudge is appended first, naming what failed and telling the model to send
    // the work in smaller pieces. A blind retry (the old behavior) tended to reproduce the same
    // oversized payload until the retry budget ran out, turning one failure into four.
    //
    // The partial assistant message is intentionally left in tab.messages: message_end has
    // already been emitted for it, so removing it would desync the UI, and it carries no
    // tool_call blocks at this point (those are only pushed further down). Worst case on the wire
    // is a half-finished sentence immediately followed by the nudge that explains it.
    tab.messages.push(
      buildToolArgsRetryNudgeMessage(argsFailure === 'none' ? 'empty' : argsFailure, unparsableToolNames)
    )
    await sessionStore.updateTab(tab)
    return agentLoop(tab, apiKey, subagentModel, emit, signal, subagentDepth, subagentCtx, stepCount, truncationRetries + 1, auditCorrections, compactionResumes, auditResumes)
  }

  if (!toolCalls.length) {
    emit({ type: 'message_end', tabId: tab.id, messageId: assistantId, usage: assistantMsg.usage })
    // This is the exit the CoFrame fabrication took: a long, confident, entirely un-executed
    // summary with no tool calls, which used to end the turn as a clean 'natural' completion.
    const outcome = await runAudit()
    await sessionStore.updateTab(tab)
    const action = await applyAuditEnforcement(outcome)
    if (action === 'audit_failed') return 'audit_failed'
    if (action === 'correct') {
      return agentLoop(tab, apiKey, subagentModel, emit, signal, subagentDepth, subagentCtx, stepCount + 1, 0, auditCorrections + 1, compactionResumes, auditResumes)
    }
    // Structural defense against the "froze after compaction" bug: compaction injects a summary
    // system message mid-turn, models read it as a wrap-up point, and a text-only reply with no
    // tool calls lands right here — which is indistinguishable from a genuinely finished task, so
    // the turn used to end silently mid-work (spinner stops, no error, no event). Observed three
    // times in one session, always at a phase boundary with an unfinished checklist.
    //
    // Note this is checked AFTER the audit: a forced correction takes precedence (it already
    // recurses), and `auditForcedCorrection` is therefore passed as a literal false rather than
    // `action === 'correct'` — that branch returned above, so TS has already narrowed it away.
    if (
      shouldResumeAfterCompaction({
        compactedThisStep: compacted.compacted,
        unfinishedChecklistItems,
        compactionResumes,
        auditForcedCorrection: false
      })
    ) {
      console.log(
        `[compaction] resuming turn (tab=${tab.id}): step with compaction ended with no tool calls, ${unfinishedChecklistItems} checklist item(s) still unfinished`
      )
      tab.messages.push(buildCompactionResumeMessage(unfinishedChecklistItems, nextUnfinishedChecklistItem))
      await sessionStore.updateTab(tab)
      return agentLoop(
        tab,
        apiKey,
        subagentModel,
        emit,
        signal,
        subagentDepth,
        subagentCtx,
        stepCount + 1,
        0,
        auditCorrections,
        compactionResumes + 1,
        auditResumes
      )
    }

    // Companion structural defense for the fabrication guard's own stall. An AUTOMATED
    // VERIFICATION NOTICE is answered in prose — a retraction, or a citation of the ledger entries
    // backing the claim — so the correction turn lands right here with no tool calls and ends the
    // turn with the real task still unfinished. Branch (b) of the notice ("the work WAS done")
    // guarantees it: there is nothing to redo, so that reply is pure text by construction, which
    // made a spurious flag cost a full turn AND a stall. buildAuditNote now also tells the model to
    // carry on in the same message, but prompt-only wording is exactly what failed for the
    // post-compaction stop, so the harness enforces the continuation structurally as well.
    //
    // `forcedCorrectionThisStep` is a literal false for the same reason as the compaction check
    // above: the 'correct' branch already returned, so TS has narrowed that case away.
    if (
      shouldResumeAfterAuditCorrection({
        auditCorrections,
        unfinishedChecklistItems,
        auditResumes,
        forcedCorrectionThisStep: false
      })
    ) {
      console.log(
        `[audit] resuming turn (tab=${tab.id}): post-correction step ended with no tool calls, ${unfinishedChecklistItems} checklist item(s) still unfinished`
      )
      tab.messages.push(buildAuditResumeMessage(unfinishedChecklistItems, nextUnfinishedChecklistItem))
      await sessionStore.updateTab(tab)
      return agentLoop(
        tab,
        apiKey,
        subagentModel,
        emit,
        signal,
        subagentDepth,
        subagentCtx,
        stepCount + 1,
        0,
        auditCorrections,
        compactionResumes,
        auditResumes + 1
      )
    }
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
      // 'queued', not 'running': every call in a step is recorded here up front, but execution
      // may not begin for a long time (approval queues are a human wait). executeTool flips this
      // to 'running' at the moment it actually reaches dispatch.
      status: 'queued'
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
  const toolExecution = Promise.all(
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
        settings.browserAutomation,
        settings.docxAvailableInCoding,
        {
          model: settings.imageModel,
          spendingCapUsd: settings.spendingCapUsd,
          spendingCapPeriod: settings.spendingCapPeriod
        },
        {
          spendingCapUsd: settings.spendingCapUsd,
          spendingCapPeriod: settings.spendingCapPeriod
        }
      )
    )
  )
  // We may stop observing this on abort (below); claim any later rejection so an abandoned tool
  // call can't surface as an unhandled rejection and take down the main process.
  void toolExecution.catch(() => undefined)

  // Race tool execution against the abort signal rather than awaiting it unconditionally.
  // Not every tool internal is cancellable — Playwright's page.evaluate() in particular cannot
  // be killed once it's waiting on a busy renderer main thread — so a wedged tool call may never
  // return at all. Without this race, one hung call blocks the turn forever, and because
  // launchAgentLoop() (turn-lifecycle.ts) serializes a tab's runs, it *also* holds up the next
  // queued user message until the hang clears: that is what made an earlier browser-inspect hang
  // present as "the app silently swallowed my chat messages", with Stop appearing to do nothing.
  // Stop now always unwinds the turn promptly. The abandoned call settles unobserved and its
  // result is discarded — which changes no mutation semantics, since the pre-existing
  // `if (signal.aborted)` check already discarded results after an abort.
  let onAbort: (() => void) | undefined
  const outcome = await Promise.race([
    toolExecution.then((results) => ({ aborted: false as const, results })),
    new Promise<{ aborted: true }>((resolve) => {
      onAbort = () => resolve({ aborted: true })
      signal.addEventListener('abort', onAbort, { once: true })
    })
  ]).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  })

  if (outcome.aborted || signal.aborted) return 'aborted'
  const results = outcome.results

  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i]
    const result = results[i]

    // Some read-only tools (read_image today) return the raw image bytes as data.dataUrl so the
    // model can actually see them — but a `tool`-role message's content can't itself carry an
    // image_url part on OpenAI-compatible APIs (only 'user' can — see messages.ts's doc comment),
    // so lift it out into a real ImageBlock on this tool message instead. MessageBubble already
    // renders any ImageBlock regardless of role, and toORMessages resends it as an image content
    // part on every subsequent turn, exactly like a user-pasted image. Stripped from the payload
    // itself (result.payload and the assistant's mirrored tool_call block share this same `data`
    // object) so the — often large — base64 blob isn't also duplicated into the JSON-stringified
    // tool result text that gets persisted and replayed via compactToolResult.
    const resultData = result.payload.data as Record<string, unknown> | undefined
    let imageDataUrl: string | undefined
    // generate_image additionally sets data.imageUiOnly, which becomes ImageBlock.uiOnly: the user
    // sees the thumbnail of the image they paid for, but it is never re-uploaded to the model on
    // later turns (messages.ts filters uiOnly blocks off the wire). read_image deliberately leaves
    // the flag unset — there, putting the image *into* context is the entire point of the call.
    let imageUiOnly = false
    if (resultData && typeof resultData.dataUrl === 'string') {
      imageDataUrl = resultData.dataUrl
      delete resultData.dataUrl
      imageUiOnly = resultData.imageUiOnly === true
      delete resultData.imageUiOnly
    }

    const toolCallBlock: ContentBlock = {
      type: 'tool_call',
      id: tc.id,
      toolName: tc.function.name,
      args: {},
      status: result.status,
      result: result.payload
    }
    const toolMsg: ChatMessage = {
      id: nanoid(),
      role: 'tool',
      blocks: imageDataUrl
        ? [toolCallBlock, { type: 'image', dataUrl: imageDataUrl, ...(imageUiOnly ? { uiOnly: true } : {}) }]
        : [toolCallBlock],
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

  // Second audit point: a turn that made *some* real calls can still narrate results that none of
  // them support (the incident's message did exactly this — 6 genuine calls, then invented
  // everything after). Running here as well as at the no-tool-calls exit covers that mixed case.
  const mixedOutcome = await runAudit()
  const mixedAction = await applyAuditEnforcement(mixedOutcome)
  if (mixedAction === 'audit_failed') return 'audit_failed'
  await sessionStore.updateTab(tab)
  return agentLoop(
    tab,
    apiKey,
    subagentModel,
    emit,
    signal,
    subagentDepth,
    subagentCtx,
    stepCount + 1,
    0,
    mixedAction === 'correct' ? auditCorrections + 1 : auditCorrections,
    compactionResumes,
    auditResumes
  )
}

/**
 * Wraps buildToolArgsRetryNudge's text as a history message.
 *
 * Same `role: 'user'` + `isAuditNote` mechanics as the fabrication guard's audit note (see
 * buildAuditNoteMessage in verify/audit.ts): toORMessages() only emits system messages for the
 * prompt/summary prefix, so a 'system'-role entry mid-history would never reach the model at all,
 * and `isAuditNote` is what stops every "what did the user last say" consumer from mistaking it
 * for real user input. `noteKind` only selects the renderer's header text.
 */
function buildToolArgsRetryNudgeMessage(
  kind: 'truncated' | 'invalid' | 'empty',
  toolNames: string[]
): ChatMessage {
  return {
    id: nanoid(),
    role: 'user',
    blocks: [{ type: 'text', text: buildToolArgsRetryNudge(kind, toolNames) }],
    createdAt: Date.now(),
    isAuditNote: true,
    noteKind: 'truncation'
  }
}

/**
 * Wraps buildAuditResumeNudge's text as a history message. Same `role: 'user'` + `isAuditNote`
 * mechanics as the truncation nudge above.
 */
function buildAuditResumeMessage(unfinishedItems: number, nextItem?: string): ChatMessage {
  return {
    id: nanoid(),
    role: 'user',
    blocks: [{ type: 'text', text: buildAuditResumeNudge({ unfinishedItems, nextItem }) }],
    createdAt: Date.now(),
    isAuditNote: true,
    noteKind: 'audit_resume'
  }
}

/**
 * Wraps buildCompactionResumeNudge's text as a history message. Same `role: 'user'` +
 * `isAuditNote` mechanics as the truncation nudge above — see that function's comment for why
 * a 'system'-role entry mid-history would never reach the model at all.
 */
function buildCompactionResumeMessage(unfinishedItems: number, nextItem?: string): ChatMessage {
  return {
    id: nanoid(),
    role: 'user',
    blocks: [{ type: 'text', text: buildCompactionResumeNudge({ unfinishedItems, nextItem }) }],
    createdAt: Date.now(),
    isAuditNote: true,
    noteKind: 'compaction_resume'
  }
}

/** Name of the most recent tool call anywhere in the history, for the `[compaction]` diagnostic
 *  (specifically: was this step preceded by an `update_checklist` call?). Walks backwards and
 *  stops at the first hit, so it's O(1) in practice on a long history. */
function lastToolCallName(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i].blocks
    for (let j = blocks.length - 1; j >= 0; j--) {
      if (blocks[j].type === 'tool_call') return (blocks[j] as ToolCallBlock).toolName
    }
  }
  return undefined
}

/**
 * The slice of AppSettings that generate_image's dispatch case needs. Threaded explicitly rather
 * than re-read from disk inside dispatchTool, both to match how shellId/browserAutomation/
 * docxAvailableInCoding already travel and so every tool in one turn sees one consistent snapshot.
 */
interface ImageGenDispatch {
  /** AppSettings.imageModel — null when the user hasn't picked one (the tool is hidden then). */
  model: string | null
  spendingCapUsd: number | null
  spendingCapPeriod: 'session' | 'daily'
}

/**
 * The slice of AppSettings parallel_write's dispatch case needs. Kept separate from
 * ImageGenDispatch — which is specifically the *image model* slice — even though both happen to
 * carry the spend cap, so neither tool's dispatch has to know about the other's settings. Both are
 * filled from the same loadSettings() snapshot at the single executeTool call site, so every tool
 * in one turn still sees one consistent view.
 */
interface ParallelWriteDispatch {
  spendingCapUsd: number | null
  spendingCapPeriod: 'session' | 'daily'
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
  browserAutomation?: BrowserAutomationSettings,
  docxAvailableInCoding?: boolean,
  imageGen?: ImageGenDispatch,
  parallelWrite?: ParallelWriteDispatch
): Promise<{ payload: ToolResultPayload; status: ToolCallBlock['status'] }> {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
  } catch {
    // Reached only once the retry path above is exhausted. Two rules here: never dispatch a tool
    // whose arguments didn't parse (a tolerant normalizer would otherwise turn `{}` into a
    // confusing "called with no files"), and never report it as the bare 'Invalid JSON args' this
    // replaced — that named neither the tool, the size, the cause, nor what to do differently, so
    // it read like an internal bug instead of "that payload was too big, send less".
    const raw = tc.function.arguments ?? ''
    return {
      payload: {
        ok: false,
        summary: describeToolArgsFailure(tc.function.name, raw),
        error: 'parse',
        data: {
          toolName: tc.function.name,
          argChars: raw.length,
          looksTruncated: looksLikeTruncatedJson(raw)
        }
      },
      status: 'error'
    }
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

  // Same defense-in-depth idea as the CODING_ONLY_TOOLS gate above, for the docx tools' own
  // opt-in flag (AppSettings.docxAvailableInCoding, default off) — independent of
  // getToolDefinitions() only hiding these from the model on project tabs where the setting is
  // off. Assistant tabs are unaffected (docx is always part of ASSISTANT_TOOLS there).
  if (tab.kind !== 'assistant' && !docxAvailableInCoding && (DOCX_TOOLS as string[]).includes(name)) {
    return {
      payload: {
        ok: false,
        summary: `${name} is disabled on coding tabs. Enable it in Settings \u2192 Integrations \u2192 Word documents (.docx) if you want the agent to use it here.`,
        error: 'docx_disabled_in_coding'
      },
      status: 'error'
    }
  }

  // File tools (read_file/write_file/edit_file/multi_edit/delete_file/grep/glob) resolve
  // relative paths and sandbox mutations against this root instead of the open workspace when
  // the call came from an Assistant tab — see documentsDir.ts and AppSettings.documentsDirectory.
  // undefined here means \"use the open project workspace\" (file-ops.ts/search.ts's existing
  // default), which is exactly the old behavior for every non-Assistant tab.
  const fileRoot = tab.kind === 'assistant' ? await resolveDocumentsDirectory() : undefined

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

  // create_pawprint/update_pawprint are ALWAYS hard-blocked pending human approval regardless of
  // approvalMode — including 'accept_all'/auto and even inside a subagent (unlike every other
  // mutating tool above, which auto-approves for subagents). This is the plan's non-negotiable
  // constraint: source/package/domain review must never be skippable. See ALWAYS_BLOCKED_TOOLS's
  // doc comment in shared/types.ts.
  if ((ALWAYS_BLOCKED_TOOLS as string[]).includes(name)) {
    if (subagentCtx) {
      return {
        payload: {
          ok: false,
          summary: `${name} is not available inside a subagent — it always requires interactive human approval. Report this back to the parent task instead.`,
          error: 'unsupported_in_subagent'
        },
        status: 'error'
      }
    }
    const kind = name as PendingActionKind
    const preview = await previewMutatingTool(name, args, fileRoot)
    const action = approvalManager.buildPendingFromTool(tab.id, tc.id, kind, preview.title, preview.extra)
    emit({ type: 'pending_action', tabId: tab.id, action })
    const decision = await approvalManager.waitForDecision(action.id)
    emit({ type: 'pending_action_resolved', tabId: tab.id, actionId: action.id })
    if (decision === 'reject') {
      return { payload: { ok: false, summary: 'User rejected action', error: 'rejected' }, status: 'rejected' }
    }
  }

  // parallel_write is deliberately ABSENT from this list. At this point its content does not exist
  // yet — there is nothing to diff or show a human until its workers have generated something — so
  // it requests approval from inside the tool instead, once per job, through the injected
  // approve() callback. Listing it here would queue a second, contentless approval card per call.
  if (['write_file', 'edit_file', 'multi_edit', 'multi_write', 'delete_file', 'write_docx', 'edit_docx', 'generate_image', 'run_command'].includes(name)) {
    // 'manual': everything needs review. 'command': only run_command needs review — file edits
    // are auto-applied like 'auto' mode. 'auto': nothing needs review.
    const needsApproval = approvalMode === 'manual' || (approvalMode === 'command' && name === 'run_command')
    if (needsApproval) {
      const kind = name as PendingActionKind
      const preview = await previewMutatingTool(name, args, fileRoot)
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

  // Past every gate (tool availability, approval, browser policy): the work starts now. Mutating
  // the recorded block as well as emitting keeps stored history honest about which calls actually
  // began, and matches the pre-split behavior where a dispatched call read as 'running'.
  const assistantMessage = tab.messages.find((m) => m.id === assistantMessageId)
  const recordedBlock = assistantMessage?.blocks.find(
    (b): b is ToolCallBlock => b.type === 'tool_call' && b.id === tc.id
  )
  if (recordedBlock && recordedBlock.status === 'queued') recordedBlock.status = 'running'
  emit({
    type: 'tool_call_status',
    tabId: tab.id,
    messageId: assistantMessageId,
    toolCallId: tc.id,
    status: 'running'
  })

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
      onToolProgress,
      fileRoot,
      imageGen,
      parallelWrite,
      // parallel_write queues its own approval cards from inside the tool, so unlike every other
      // tool it needs this call's id to attach them to.
      tc.id
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
  onToolProgress?: (message: string) => void,
  /** Sandbox root for file tools — see the matching parameter on executeTool/
   *  previewMutatingTool above. undefined means "use the open project workspace". */
  fileRoot?: string,
  /** Only generate_image uses this; see ImageGenDispatch. */
  imageGen?: ImageGenDispatch,
  /** Only parallel_write uses this; see ParallelWriteDispatch. */
  parallelWrite?: ParallelWriteDispatch,
  /** Only parallel_write uses this — it builds its own per-job PendingActions and needs the
   *  owning tool call's id to hang them off. */
  toolCallId?: string
): Promise<ToolResultPayload> {
  switch (name) {
    case 'read_file':
      return readFileTool(args as { path: string; offset?: number; limit?: number }, fileRoot)
    case 'write_file':
      return writeFileTool(args as { path: string; content: string }, fileRoot)
    case 'edit_file':
      return editFileTool(
        args as { path: string; old_string: string; new_string: string; replace_all?: boolean },
        fileRoot
      )
    case 'multi_edit':
      return multiEditFileTool(args as unknown as { edits: MultiEditOp[]; path?: string }, fileRoot)
    case 'parallel_write': {
      // Subagents are excluded by this RUNTIME check, not by the allow-lists. Plan mode omits
      // parallel_write from planAllowed and Assistant tabs omit it via CODING_ONLY_TOOLS, but a
      // subagent *type* can declare `tools: 'all'` (general-purpose does), so allow-lists alone
      // would let it through — and subagent runs force approvalMode 'auto' (effectiveApprovalMode
      // in agentLoop), which would apply every worker's output with nobody reviewing any of it,
      // on top of nesting paid fan-out inside an already-delegated run. Blocked outright rather
      // than silently degraded, mirroring ALWAYS_BLOCKED_TOOLS's subagent branch in executeTool.
      if (unattended) {
        return {
          ok: false,
          summary:
            'parallel_write is not available inside a subagent — its per-job approval needs an interactive human, and subagent runs force auto-approval. Use multi_write/multi_edit here, or report back to the parent task.',
          error: 'unsupported_in_subagent'
        }
      }
      if (!parallelWrite || !toolCallId) {
        return { ok: false, summary: 'parallel_write is not available in this context', error: 'not_configured' }
      }
      const workerModelInfo = models.find((m) => m.id === tab.model)
      if (!workerModelInfo) {
        return {
          ok: false,
          summary: `No model metadata for ${tab.model}, so worker token limits and cache pricing can't be resolved`,
          error: 'not_configured'
        }
      }
      // Same reasoning as generate_image's check directly below: checkSpendCap otherwise runs only
      // at turn start (turn-lifecycle.ts), so a single turn could fan out many paid generations
      // before the next check ever happens. It throws after emitting spend_blocked, and
      // executeTool's try/catch turns that into a normal failed tool result rather than tearing
      // down the turn.
      checkSpendCap(tab, parallelWrite.spendingCapUsd, parallelWrite.spendingCapPeriod)

      const workerMaxTokens = workerModelInfo.maxCompletionTokens ?? DEFAULT_MAX_COMPLETION_TOKENS

      // Attributes one worker's (or the primer's) usage exactly like a chat turn's, so the cap
      // checked above, the tab total and the Cost Report all account for the fan-out. Without
      // this, N paid requests would be invisible to the very cap they just passed.
      const attributeWorkerUsage = (usage: {
        promptTokens: number
        completionTokens: number
        cachedTokens: number
        cacheWriteTokens: number
        costUsd: number
      }): void => {
        const { costWithoutCacheUsd, cacheSavingsUsd } = computeCacheSavings(workerModelInfo, usage)
        tab.totalCostUsd += usage.costUsd
        tab.totalSavingsUsd = (tab.totalSavingsUsd ?? 0) + Math.max(cacheSavingsUsd, 0)
        trackDailySpend(usage.costUsd)
        recordUsage(getWorkspace(), tab.model, { ...usage, costWithoutCacheUsd, cacheSavingsUsd })
        emit({
          type: 'spend_update',
          tabId: tab.id,
          totalCostUsd: tab.totalCostUsd,
          totalSavingsUsd: tab.totalSavingsUsd,
          capUsd: parallelWrite.spendingCapUsd
        })
      }

      const runWorkerRequest = async (
        systemPrompt: string,
        userContent: string,
        reqSignal: AbortSignal,
        maxTokens: number
      ): Promise<{ text: string; cachedTokens: number }> => {
        const messages: ORChatMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ]
        let text = ''
        let cachedTokens = 0
        for await (const chunk of streamChatCompletion({
          apiKey,
          model: tab.model,
          messages,
          signal: reqSignal,
          supportsExplicitCaching: workerModelInfo.supportsExplicitCaching,
          // Only the shared system prefix carries a breakpoint: the per-job user content is unique
          // by construction, so marking it would spend a breakpoint on a guaranteed miss. Same
          // call runUtilityPrompt makes for the same reason.
          includeLastMessageCacheBreakpoint: false,
          maxTokens
          // Deliberately absent: `tools` (omitting the ~40-tool schema block is the single largest
          // input saving available here) and any reasoning field (workers transcribe rather than
          // plan, so reasoning tokens would be pure cost — see client.ts's 3-way reasoning logic,
          // which sends no `reasoning` field at all when neither option is passed).
        })) {
          if (chunk.type === 'text' && chunk.text) text += chunk.text
          if (chunk.type === 'usage' && chunk.usage) {
            cachedTokens = chunk.usage.cachedTokens
            attributeWorkerUsage(chunk.usage)
          }
          if (chunk.type === 'error') throw new Error(chunk.error ?? 'worker request failed')
        }
        return { text, cachedTokens }
      }

      // Carried across the prime -> fan-out -> effectiveness-learning sequence.
      let primedPrefixTokens = 0
      let didPrime = false

      return parallelWriteTool(args, {
        root: fileRoot,
        signal,
        onProgress: onToolProgress,
        generate: async (req: WorkerRequest) =>
          runWorkerRequest(req.systemPrompt, req.userContent, req.signal, workerMaxTokens),
        prime: async (systemPrompt: string, jobCount: number) => {
          const prefixTokens = estimatePrefixTokens(systemPrompt)
          const prefixHash = hashPrefix(systemPrompt)
          const decision = shouldPrimeCache({
            model: workerModelInfo,
            prefixTokens,
            jobCount,
            prefixLastSentAt: prefixLastSentAt(prefixHash),
            now: Date.now(),
            ineffective: isCachePrimingIneffective(tab.model)
          })
          console.log(
            `[cache] parallel_write priming ${decision.prime ? 'ARMED' : 'skipped'} (${jobCount} jobs, ~${prefixTokens} prefix tokens): ${decision.reason}`
          )
          // Recorded whether or not we prime: the workers are about to send this prefix either
          // way, so a FOLLOWING parallel_write sharing the same context must see it as warm and
          // not pay a second write premium for nothing.
          notePrefixSent(prefixHash)
          if (!decision.prime) return false
          primedPrefixTokens = prefixTokens
          try {
            // maxTokens 1: the point is to make the provider read and cache the prefix, not to
            // generate anything. The user content just has to be non-empty.
            await runWorkerRequest(systemPrompt, 'ready', signal, 1)
            didPrime = true
            return true
          } catch (e) {
            // Priming is a pure optimization — degrade to a cold fan-out, never fail the call.
            console.log(
              `[cache] parallel_write priming request failed, continuing cold: ${e instanceof Error ? e.message : String(e)}`
            )
            return false
          }
        },
        onPrimingUsage: (cachedTokensPerWorker: number[]) => {
          if (!didPrime) return
          if (primingLookedIneffective(cachedTokensPerWorker, primedPrefixTokens)) {
            markCachePrimingIneffective(tab.model)
            console.log(
              `[cache] parallel_write priming produced no cache reads on ${tab.model} — not priming it again this process`
            )
          }
        },
        approve: async (req: JobApprovalRequest) => {
          const fileCount = req.paths.length
          const title = `${req.kind === 'edit' ? 'Edit' : 'Write'} ${fileCount} file${fileCount === 1 ? '' : 's'} — ${req.label}`
          // N actions deliberately share one toolCallId, exactly as N concurrent write_file calls
          // already produce today: nothing downstream keys off toolCallId, and ChatPane renders
          // every pending action for the tab.
          const action = approvalManager.buildPendingFromTool(tab.id, toolCallId, 'parallel_write', title, {
            diff: req.diff
          })
          emit({ type: 'pending_action', tabId: tab.id, action })
          const decision = await approvalManager.waitForDecision(action.id)
          emit({ type: 'pending_action_resolved', tabId: tab.id, actionId: action.id })
          return decision === 'reject' ? 'reject' : 'approve'
        }
      })
    }
    case 'multi_write':
      return multiWriteFileTool(args as { files?: unknown; path?: unknown; content?: unknown }, fileRoot)
    case 'delete_file':
      return deleteFileTool(args as { path: string }, fileRoot)
    case 'read_docx':
      return readDocxTool(args as { path: string }, fileRoot)
    case 'read_image':
      return readImageTool(args as { path: string }, fileRoot)
    case 'generate_image': {
      // A per-call `model` override wins over the configured AppSettings.imageModel. The tool
      // itself also rejects a missing model, but check here first so a call that can't run at all
      // never reaches the spend-cap check (or looks like it was blocked on spend).
      const requestedModel = typeof args.model === 'string' ? args.model.trim() : ''
      const imageModel = requestedModel || imageGen?.model
      if (!imageModel) {
        return {
          ok: false,
          summary: 'No image model is configured',
          error: 'not_configured',
          data: { detail: 'Pick an image model in Settings \u2192 Models \u2192 Image generation, then retry.' }
        }
      }
      // Deliberately NEW behavior relative to every other tool: checkSpendCap otherwise runs only
      // at turn start (turn-lifecycle.ts), so a single turn could fire many paid generations
      // before the next check ever happens. It throws 'Spending cap exceeded' (after emitting
      // spend_blocked), which executeTool's try/catch converts into a normal failed tool result
      // instead of tearing down the turn.
      checkSpendCap(tab, imageGen?.spendingCapUsd ?? null, imageGen?.spendingCapPeriod ?? 'session')
      const imageResult = await generateImageTool(args as GenerateImageToolArgs, {
        apiKey,
        model: imageModel,
        root: fileRoot,
        signal,
        onProgress: onToolProgress
      })
      // Attribute the spend exactly like a chat turn's, so the daily cap checked above, the tab
      // total, and the Cost Report all account for it. Note this reads costUsd off the payload
      // before returning, since the caller strips other keys (dataUrl/imageUiOnly) off this same
      // object afterwards.
      const imageData = (imageResult.data ?? {}) as Record<string, unknown>
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const imageCost = num(imageData.costUsd)
      if (imageCost > 0) {
        tab.totalCostUsd += imageCost
        trackDailySpend(imageCost)
        recordUsage(getWorkspace(), imageModel, {
          costUsd: imageCost,
          promptTokens: num(imageData.promptTokens),
          completionTokens: num(imageData.completionTokens),
          // The /images endpoint has no prompt cache, so there is nothing cached, nothing
          // written to a cache, and no saving: the counterfactual cost is just the real cost.
          cachedTokens: 0,
          cacheWriteTokens: 0,
          costWithoutCacheUsd: imageCost,
          cacheSavingsUsd: 0
        })
      }
      return imageResult
    }
    case 'write_docx':
      return writeDocxTool(args as any, fileRoot)
    case 'edit_docx':
      return editDocxTool(args as any, fileRoot)
    case 'grep':
      return grepTool(
        args as { pattern: string; path?: string; glob?: string; case_insensitive?: boolean; context?: number },
        signal,
        fileRoot
      )
    case 'glob':
      return globTool(args as { pattern: string; cwd?: string }, fileRoot)
    case 'run_command':
      return runCommandTool(args as { command: string; cwd?: string; timeout_ms?: number }, signal, shellId)
    case 'read_terminal':
      return readTerminalTool(args as { lines?: number })
    case 'read_app_log':
      return readAppLogTool(args as { lines?: number; filter?: string })
    case 'web_search':
      return webSearchTool(args as { query: string })
    case 'fetch_url':
      return fetchUrlTool(args as { url: string })
    case 'list_skills': {
      const skills = await listSkills()
      return { ok: true, summary: `${skills.length} skills`, data: { skills } }
    }
    case 'read_skill': {
      // Accepts a skill name (preferred, straight from the system-prompt catalog), a catalog line,
      // or a real path — resolveSkill/readSkillDetailed handle all three, so a bare name no longer
      // fails with ENOENT and forces a list_skills round-trip first.
      const ref = args.name ?? args.path ?? args.skill
      const skill = await readSkillDetailed(ref)
      return {
        ok: true,
        summary: `Skill loaded: ${skill.name} (${skill.scope})`,
        data: { name: skill.name, scope: skill.scope, path: skill.path, content: skill.content }
      }
    }
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
      {
        const requestedTopic = String(args.topic)
        const savedTopic = await writeMemory(args.scope as 'project' | 'global', requestedTopic, String(args.content))
        const summary =
          savedTopic === requestedTopic
            ? 'Memory saved'
            : `Memory saved as "${savedTopic}" (topic was sanitized: illegal filename characters were stripped/replaced from "${requestedTopic}")`
        return { ok: true, summary, data: { topic: savedTopic } }
      }
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
      const checklist = coerceArrayArg(args.checklist).filter((x): x is string => typeof x === 'string').slice(0, 20)
      const plan = await savePlan(String(args.slug), String(args.title), String(args.markdown), checklist, tab.id)
      return { ok: true, summary: 'Plan saved', data: { plan } }
    }
    case 'create_checklist': {
      const title = String(args.title ?? '').trim()
      const itemTexts = coerceArrayArg(args.items).filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      if (!title || itemTexts.length === 0) {
        return { ok: false, summary: 'create_checklist requires a non-empty title and at least one item.', error: 'invalid_args' }
      }
      if (tab.activeChecklist && args.replace !== true) {
        return {
          ok: false,
          summary: `A checklist ("${tab.activeChecklist.title}") is already active on this tab. Pass replace: true to intentionally discard it and start a new one, or keep using update_checklist against the existing one.`,
          error: 'checklist_already_active'
        }
      }
      const { message: checklistMsg, activeChecklist } = buildChecklist(title, itemTexts.slice(0, 20))
      tab.messages.push(checklistMsg)
      tab.activeChecklist = activeChecklist
      await sessionStore.updateTab(tab)
      emit({ type: 'tab_upserted', tab })
      return { ok: true, summary: `Checklist "${title}" created with ${activeChecklist.items.length} item(s).`, data: { activeChecklist } }
    }
    case 'update_checklist': {
      if (!tab.activeChecklist) {
        return { ok: false, summary: 'No active checklist on this tab.', error: 'no_active_checklist' }
      }
      const rawUpdates = coerceArrayArg(args.updates)
      const items = tab.activeChecklist.items.map((it) => ({ ...it }))
      // Plan-gate evidence requirement. The tool_call blocks for this very message are already
      // recorded by the time dispatch runs, so this ledger covers the whole turn *including* the
      // update_checklist call itself — turnHasSubstantiveToolCall() filters out checklist
      // bookkeeping, since marking an item done can't be its own supporting evidence.
      //
      // Deliberately NOT a rejection: refusing the update would leave the checklist silently
      // stale, which is worse than an honestly-labelled "done". Instead the item is marked done
      // and tagged as unbacked, which the widget and the re-injected checklist note both surface.
      const turnDidRealWork = turnHasSubstantiveToolCall(buildTurnLedger(tab.messages))
      for (const u of rawUpdates) {
        if (!u || typeof u !== 'object') continue
        const { index, done, evidence } = u as { index?: unknown; done?: unknown; evidence?: unknown }
        const i = Number(index) - 1
        if (!Number.isInteger(i) || i < 0 || i >= items.length || typeof done !== 'boolean') continue
        items[i].done = done
        // Store the truncated value at write time so every downstream reader (widget,
        // buildCurrentTimeNote reinjection, compaction transcript) can use it as-is without ever
        // needing to re-truncate or risk diverging from what's actually persisted.
        if (typeof evidence === 'string' && evidence.trim()) {
          items[i].evidence = evidence.trim().slice(0, 300)
        }
        // Recomputed on every write rather than only ever being set: an item re-marked done in a
        // turn that *did* do real work should lose a stale unverified tag, and an item being
        // un-marked shouldn't carry one at all.
        if (done && !turnDidRealWork) {
          items[i].evidenceQuality = 'unverified-no-tool-calls'
        } else {
          delete items[i].evidenceQuality
        }
      }
      tab.activeChecklist = { ...tab.activeChecklist, items }
      // Mutate the same ChecklistBlock in place (by message id) rather than appending a new
      // message — this is what makes the widget update live instead of piling up duplicates.
      const msgIdx = tab.messages.findIndex((m) => m.id === tab.activeChecklist!.messageId)
      const msg = msgIdx >= 0 ? tab.messages[msgIdx] : undefined
      const block = msg?.blocks.find((b) => b.type === 'checklist') as ChecklistBlock | undefined
      if (block) block.items = items
      // Also relocate the message to the end of the transcript. Mutating in place keeps the
      // widget from appearing where it was first created (right after plan approval) even as
      // later tool calls and assistant text get appended below it — from the user's perspective
      // it looks "stuck" up in the scroll history instead of tracking the work currently
      // happening at the bottom. Moving it on every update makes it resurface right after
      // whatever just triggered this call, exactly where the user's eyes already are.
      if (msg && msgIdx >= 0 && msgIdx !== tab.messages.length - 1) {
        tab.messages.splice(msgIdx, 1)
        tab.messages.push(msg)
      }
      await sessionStore.updateTab(tab)
      emit({ type: 'tab_upserted', tab })
      const doneCount = items.filter((it) => it.done).length
      const unbacked = items.filter((it) => it.done && it.evidenceQuality === 'unverified-no-tool-calls').length
      // Told to the model plainly, so it knows the tag was applied and why — silently flagging it
      // would leave the model asserting completion while the UI says otherwise.
      const unbackedNote =
        unbacked > 0
          ? ` — note: ${unbacked} item(s) marked done in a turn with no substantive tool calls are tagged "unverified"; do the underlying work with real tool calls, or say plainly that it isn't done.`
          : ''
      return {
        ok: true,
        summary: `Checklist updated (${doneCount}/${items.length} done)${unbackedNote}`,
        data: { items }
      }
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
    case 'create_pawprint': {
      const instanceModel = args.instanceModel === 'per-item' ? 'per-item' : 'single'
      return createPawprint({
        name: String(args.name ?? ''),
        description: String(args.description ?? ''),
        instanceModel,
        source: String(args.source ?? ''),
        packages: coercePawprintPackages(args.packages),
        domains: coerceArrayArg(args.domains).filter((d): d is string => typeof d === 'string')
      })
    }
    case 'update_pawprint':
      return updatePawprint({
        pawprintId: String(args.pawprintId ?? ''),
        source: String(args.source ?? ''),
        packages: coercePawprintPackages(args.packages),
        domains: coerceArrayArg(args.domains).filter((d): d is string => typeof d === 'string')
      })
    case 'read_pawprint_source':
      return readPawprintSource(String(args.pawprintId ?? ''))
    default:
      return { ok: false, summary: `Unknown tool ${name}`, error: 'unknown' }
  }
}

/** Coerces create_pawprint/update_pawprint's `packages` arg into a clean { name, version }[],
 *  tolerating the model sending a stringified-JSON array (see coerceArrayArg) or malformed
 *  entries — malformed entries are silently dropped rather than crashing the tool call; the
 *  package pipeline downstream will fail closed on any genuinely missing/invalid package name. */
function coercePawprintPackages(raw: unknown): { name: string; version: string }[] {
  return coerceArrayArg(raw)
    .map((p) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : null))
    .filter((p): p is Record<string, unknown> => p !== null && typeof p.name === 'string' && typeof p.version === 'string')
    .map((p) => ({ name: String(p.name), version: String(p.version) }))
}

/** Coerces a tool argument that the schema declares as an array into a real array, tolerating
 *  the common case (see repo gotchas) where a model sends a JSON-encoded string instead of a
 *  native array for a nested-array parameter. Returns [] for anything else (missing, wrong type,
 *  or a string that fails to parse / doesn't parse to an array) rather than throwing, since both
 *  call sites treat "no items" as a valid (if unhelpful) input. */
export function coerceArrayArg(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // fall through to []
    }
  }
  return []
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
    case 'multi_write': {
      const normalized = normalizeFilesArg(args.files, { path: args.path, content: args.content })
      const paths = normalized.ok ? [...new Set(normalized.files.map((f) => f.path))] : []
      return paths.length > 1 ? `Writing ${paths.length} files` : `Writing ${paths[0] ?? 'files'}`
    }
    case 'delete_file':
      return `Deleting ${str(args.path) ?? 'file'}`
    case 'generate_image':
      return str(args.path) ? `Generating image ${str(args.path)}` : 'Generating an image'
    case 'read_docx':
      return `Reading ${str(args.path) ?? 'docx file'}`
    case 'write_docx':
      return `Writing ${str(args.path) ?? 'docx file'}`
    case 'edit_docx':
      return `Editing ${str(args.path) ?? 'docx file'}`
    case 'grep':
      return `Searching for "${str(args.pattern) ?? ''}"`
    case 'glob':
      return `Finding files matching "${str(args.pattern) ?? ''}"`
    case 'run_command':
      return `Running: ${str(args.command) ?? 'command'}`
    case 'read_terminal':
      return 'Reading terminal log'
    case 'read_app_log':
      return 'Reading app log'
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

    // Per the scoping matrix, a subagent gets no forced-correction loop (no UI to click Continue,
    // and a fixed step budget). Instead its findings are surfaced to the *parent* agent right in
    // the returned summary — otherwise a subagent's fabricated report would be handed upward as
    // clean, authoritative fact, which is strictly worse than the main-loop case since the parent
    // has no other window into what the subagent actually did.
    const subFindings = subTab.messages.flatMap((m) => m.verification?.findings ?? [])
    if (subFindings.length > 0) {
      summary += `\n${buildFindingsWarningBlock(subFindings)}`
    }

    run.status =
      reason === 'error' || reason === 'truncation_failed' || reason === 'audit_failed' ? 'error' : 'success'
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
