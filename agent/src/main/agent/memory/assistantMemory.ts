// Electron-touching orchestration for the Assistant-window shared, auto-compacting memory pool.
// File IO, the module-level mutex, and the actual utility-model calls live here; all the pure
// math (compaction planning, digest formatting, token estimation) lives in
// assistantMemoryPool.ts and is imported by this module rather than duplicated.
//
// No other module is allowed to touch assistant-memory.json directly — every read/modify/write
// must go through loadPool()/withPool() below so the mutex actually serializes every mutation.
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssistantMemoryPool, AssistantMemorySlot, ModelInfo, TabSession } from '@shared/types'
import { loadSettings, getApiKey } from '../../settings'
import { sessionStore } from '../../session/store'
import { fetchModels, streamChatCompletion } from '../../openrouter/client'
import { modelSupportsCaching, computeCacheSavings } from '../../openrouter/caching'
import { trackDailySpend } from '../spend'
import { recordUsage } from '../costReport'
import { emitToAll } from '../orchestrator/state'
import {
  budgetTokensFor,
  enforceRollupCeiling,
  estimateTokens,
  formatDigest,
  selectCompactionPlan
} from './assistantMemoryPool'

/** How many of a tab's most recent messages to fall back to when there's no prior
 *  `lastMemorizedMessageId` (first-ever update) or it can no longer be found in `tab.messages`
 *  (defensive fallback — e.g. history was pruned). */
const FALLBACK_TAIL_MESSAGES = 20

/** Bounds the utility-model call so a stalled request can't leave a tab's per-tab queue stuck
 *  indefinitely — this is a background, best-effort operation, never worth blocking on. */
const UTILITY_CALL_TIMEOUT_MS = 20_000

function dataFilePath(): string {
  return join(app.getPath('userData'), 'sessions', 'assistant-memory.json')
}

function emptyPool(): AssistantMemoryPool {
  return { slots: [], rollup: null }
}

// ---------- Module-level mutex (serializes every load-modify-save cycle) ----------

let poolMutex: Promise<unknown> = Promise.resolve()

/** Runs `fn` against the freshest on-disk pool state and persists whatever it returns, with the
 *  entire load-modify-save cycle serialized behind a single promise chain — this is what keeps
 *  concurrent Assistant tabs finishing turns around the same time from racing on the shared
 *  file. `fn` may return `undefined` to signal "no change, don't write" (e.g. a viewer read). */
function withPool<T>(fn: (pool: AssistantMemoryPool) => Promise<{ pool?: AssistantMemoryPool; result: T }>): Promise<T> {
  const run = poolMutex.then(async () => {
    const pool = await loadPoolFromDisk()
    const { pool: next, result } = await fn(pool)
    if (next) await savePoolToDisk(next)
    return result
  })
  // Keep the chain alive even if this particular call rejects, so a single failure doesn't
  // permanently wedge every future call behind a rejected promise.
  poolMutex = run.catch(() => undefined)
  return run
}

async function loadPoolFromDisk(): Promise<AssistantMemoryPool> {
  try {
    const raw = await readFile(dataFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<AssistantMemoryPool>
    return { slots: parsed.slots ?? [], rollup: parsed.rollup ?? null }
  } catch {
    return emptyPool()
  }
}

async function savePoolToDisk(pool: AssistantMemoryPool): Promise<void> {
  await mkdir(join(app.getPath('userData'), 'sessions'), { recursive: true })
  await writeFile(dataFilePath(), JSON.stringify(pool, null, 2), 'utf8')
}

// ---------- Per-tab write queue (serializes back-to-back completions on the same tab) ----------

const perTabQueues = new Map<string, Promise<unknown>>()

function enqueueForTab(tabId: string, fn: () => Promise<void>): Promise<void> {
  const previous = perTabQueues.get(tabId) ?? Promise.resolve()
  const run = previous.then(fn).catch((e) => {
    console.error(`[assistantMemory] update failed for tab ${tabId}:`, e)
  })
  perTabQueues.set(tabId, run)
  return run
}

// ---------- Utility-model call helper ----------

interface UtilityCallResult {
  text: string
  usage?: { promptTokens: number; completionTokens: number; cachedTokens: number; cacheWriteTokens: number; costUsd: number }
  /** the ModelInfo the call actually resolved and ran against, so callers never need to
   *  re-resolve settings.utilityModel against the catalog a second time */
  resolvedModel: ModelInfo
}

async function callUtilityModel(opts: {
  apiKey: string
  utilityModel: string
  models: ModelInfo[]
  mainModelId: string
  systemPrompt: string
  userText: string
  promptCachingEnabled: boolean
}): Promise<UtilityCallResult> {
  const mainModel = opts.models.find((m) => m.id === opts.mainModelId)
  const utilityModelInfo = opts.models.find((m) => m.id === opts.utilityModel) ?? mainModel ?? opts.models[0]
  if (!utilityModelInfo) throw new Error('No model available to resolve the utility model against.')

  const supportsExplicitCaching =
    opts.promptCachingEnabled && utilityModelInfo.supportsExplicitCaching && modelSupportsCaching(utilityModelInfo)

  const controller = new AbortController()
  const timeout = AbortSignal.timeout(UTILITY_CALL_TIMEOUT_MS)
  const onTimeoutAbort = () => controller.abort()
  timeout.addEventListener('abort', onTimeoutAbort)

  let text = ''
  let usage: UtilityCallResult['usage']
  try {
    for await (const chunk of streamChatCompletion({
      apiKey: opts.apiKey,
      model: utilityModelInfo.id,
      messages: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'user', content: opts.userText }
      ],
      signal: controller.signal,
      supportsExplicitCaching,
      includeLastMessageCacheBreakpoint: false
    })) {
      if (chunk.type === 'text' && chunk.text) text += chunk.text
      if (chunk.type === 'usage' && chunk.usage) usage = chunk.usage
      if (chunk.type === 'error') throw new Error(chunk.error)
    }
  } finally {
    timeout.removeEventListener('abort', onTimeoutAbort)
  }

  // Cache-savings computation is left to callers (they know which ModelInfo to attribute
  // against, and whether the call is tab-attributed or a pool-wide rollup) — this just returns
  // the raw usage as reported.
  return { text: text.trim(), usage, resolvedModel: utilityModelInfo }
}

function attributeUsageToTab(tab: TabSession, model: ModelInfo, usage: NonNullable<UtilityCallResult['usage']>): void {
  const { costWithoutCacheUsd, cacheSavingsUsd } = computeCacheSavings(model, usage)
  tab.totalCostUsd += usage.costUsd
  tab.totalSavingsUsd = (tab.totalSavingsUsd ?? 0) + Math.max(cacheSavingsUsd, 0)
  trackDailySpend(usage.costUsd)
  recordUsage(null, model.id, {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cachedTokens: usage.cachedTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    costUsd: usage.costUsd,
    costWithoutCacheUsd,
    cacheSavingsUsd
  })
}

// ---------- Message-range resolution ----------

function messagesSince(tab: TabSession, lastMemorizedMessageId: string | null): TabSession['messages'] {
  if (lastMemorizedMessageId) {
    const idx = tab.messages.findIndex((m) => m.id === lastMemorizedMessageId)
    if (idx !== -1) return tab.messages.slice(idx + 1)
    // Defensive fallback: the marker no longer exists (e.g. history pruned) — fall back to a
    // tail window rather than failing outright.
  }
  return tab.messages.slice(-FALLBACK_TAIL_MESSAGES)
}

function transcriptFor(messages: TabSession['messages']): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.blocks
        .filter((b) => b.type === 'text')
        .map((b) => ('text' in b ? b.text : ''))
        .join(' ')
      if (text) lines.push(`user: ${text}`)
    } else if (m.role === 'assistant') {
      const text = m.blocks
        .filter((b) => b.type === 'text')
        .map((b) => ('text' in b ? b.text : ''))
        .join(' ')
      const toolCalls = m.blocks
        .filter((b) => b.type === 'tool_call')
        .map((b) => ('toolName' in b ? `[called ${b.toolName}(${JSON.stringify(b.args)})]` : ''))
      const line = [text, ...toolCalls].filter(Boolean).join(' ')
      if (line) lines.push(`assistant: ${line}`)
    } else if (m.role === 'tool') {
      const tc = m.blocks.find((b) => b.type === 'tool_call')
      if (tc && 'result' in tc && tc.result) {
        lines.push(`tool result (${tc.toolName}): ${JSON.stringify(tc.result).slice(0, 2000)}`)
      }
    }
  }
  return lines.join('\n')
}

const MEMORY_UPDATE_SYSTEM_PROMPT = `You maintain a single short memory note for one Assistant chat window, so that OTHER Assistant windows can see at a glance what this window has been doing. You will be given the note's current content (if any) and the new messages since it was last updated. Produce the updated note.

Guidelines:
- Default to brevity: for routine or simple work (e.g. "checked email, found 2 unread, replied to one"), a single short line — who/what was involved plus a one-line stub — is enough.
- Only write more detail when the work is genuinely long-running or multi-step (e.g. a multi-stage research task, an ongoing project being tracked across many turns) where a future window would benefit from knowing specifics.
- Never include secrets, tokens, or full email/message bodies — summarize, don't quote at length.
- Write the note as plain text (no markdown headers), a few sentences at most.
- Output ONLY the updated note content, nothing else (no preamble, no "Here's the updated note:").`

/** Fires the silent memory update for one Assistant tab. No-op immediately if the setting is
 *  disabled. Enqueues onto that tab's own serial queue so back-to-back completions never
 *  interleave, and is itself fire-and-forget from the caller's perspective — any failure is
 *  logged and swallowed, never propagated to the turn that already completed. */
export function updateAssistantMemoryForTab(tabId: string): void {
  void enqueueForTab(tabId, () => doUpdate(tabId))
}

async function doUpdate(tabId: string): Promise<void> {
  const settings = await loadSettings()
  if (settings.assistantMemorySize === 'disabled') return

  const tab = sessionStore.getTab(tabId)
  if (!tab) return

  const apiKey = await getApiKey()
  if (!apiKey) return

  const priorSlot = await withPool(async (pool) => ({
    result: pool.slots.find((s) => s.tabId === tabId)
  }))

  const newMessages = messagesSince(tab, priorSlot?.lastMemorizedMessageId ?? null)
  if (newMessages.length === 0) return
  const lastIncludedId = newMessages[newMessages.length - 1].id

  const transcript = transcriptFor(newMessages)
  if (!transcript.trim()) return

  const models = await fetchModels(apiKey, false)
  const userText = priorSlot
    ? `Current note:\n${priorSlot.content}\n\nNew messages since last update:\n${transcript}`
    : `New messages:\n${transcript}`

  let callResult: UtilityCallResult
  try {
    callResult = await callUtilityModel({
      apiKey,
      utilityModel: settings.utilityModel,
      models,
      mainModelId: tab.model,
      systemPrompt: MEMORY_UPDATE_SYSTEM_PROMPT,
      userText,
      promptCachingEnabled: settings.promptCachingEnabled
    })
  } catch (e) {
    console.error(`[assistantMemory] utility-model call failed for tab ${tabId}:`, e)
    return
  }

  if (callResult.usage) {
    attributeUsageToTab(tab, callResult.resolvedModel, callResult.usage)
    await sessionStore.updateTab(tab)
    emitToAll({
      type: 'spend_update',
      tabId: tab.id,
      totalCostUsd: tab.totalCostUsd,
      totalSavingsUsd: tab.totalSavingsUsd ?? 0,
      capUsd: settings.spendingCapUsd
    })
  }

  if (!callResult.text) return

  const newSlot: AssistantMemorySlot = {
    tabId,
    tabTitle: tab.title,
    content: callResult.text,
    updatedAt: Date.now(),
    tokenEstimate: estimateTokens(callResult.text),
    lastMemorizedMessageId: lastIncludedId
  }

  await withPool(async (pool) => {
    const nextSlots = [...pool.slots.filter((s) => s.tabId !== tabId), newSlot]
    let nextPool: AssistantMemoryPool = { slots: nextSlots, rollup: pool.rollup }

    // Re-check the setting inside the same call in case it changed between the check above and
    // now — 'disabled' skips compaction too (downsizing while disabled has no effect until the
    // feature is re-enabled and a write actually occurs, per the plan).
    const freshSettings = await loadSettings()
    const budget = budgetTokensFor(freshSettings.assistantMemorySize)
    if (budget != null) {
      nextPool = await maybeCompactPool(nextPool, budget, { apiKey, utilityModel: freshSettings.utilityModel, models, mainModelId: tab.model, promptCachingEnabled: freshSettings.promptCachingEnabled })
    }

    return { pool: nextPool, result: undefined }
  })
}

const ROLLUP_SYSTEM_PROMPT = `You are compacting older Assistant-window memory notes into a single rolled-up summary. You'll be given the current rollup (if any) plus a batch of individual notes being folded into it. Produce ONE combined note.

Guidelines:
- Stay bounded: a few sentences, roughly 1500 tokens or less — never a full transcript or a list of every detail.
- Preserve only what's still useful to know at a glance (who/what, outcomes) — drop specifics that no longer matter.
- Output ONLY the combined note content, nothing else.`

async function maybeCompactPool(
  pool: AssistantMemoryPool,
  budgetTokens: number,
  ctx: { apiKey: string; utilityModel: string; models: ModelInfo[]; mainModelId: string; promptCachingEnabled: boolean }
): Promise<AssistantMemoryPool> {
  const plan = selectCompactionPlan(pool.slots, pool.rollup, budgetTokens)
  if (!plan.needsCompaction) return pool

  const priorRollupText = pool.rollup ? `Current rollup:\n${pool.rollup.content}\n\n` : ''
  const notesText = plan.toCompact
    .map((s) => `- [${s.tabTitle}] (updated ${new Date(s.updatedAt).toISOString()}): ${s.content}`)
    .join('\n')

  let rollupText: string
  try {
    const result = await callUtilityModel({
      apiKey: ctx.apiKey,
      utilityModel: ctx.utilityModel,
      models: ctx.models,
      mainModelId: ctx.mainModelId,
      systemPrompt: ROLLUP_SYSTEM_PROMPT,
      userText: `${priorRollupText}Notes to fold in:\n${notesText}`,
      promptCachingEnabled: ctx.promptCachingEnabled
    })
    rollupText = result.text
    if (result.usage) {
      // Compaction is a pool-wide operation spanning multiple tabs' history, not attributable
      // to any single tab's totalCostUsd — recorded against the global cost report only
      // (project=null), same convention as codeindex embeddings usage.
      const { costWithoutCacheUsd, cacheSavingsUsd } = computeCacheSavings(result.resolvedModel, result.usage)
      trackDailySpend(result.usage.costUsd)
      recordUsage(null, result.resolvedModel.id, {
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        cachedTokens: result.usage.cachedTokens,
        cacheWriteTokens: result.usage.cacheWriteTokens,
        costUsd: result.usage.costUsd,
        costWithoutCacheUsd,
        cacheSavingsUsd
      })
    }
  } catch (e) {
    console.error('[assistantMemory] rollup compaction failed, keeping prior state:', e)
    return pool
  }

  if (!rollupText) return pool

  const bounded = enforceRollupCeiling(rollupText)
  return {
    slots: plan.toKeep,
    rollup: { content: bounded, updatedAt: Date.now(), tokenEstimate: estimateTokens(bounded) }
  }
}

// ---------- Digest builders (read side) ----------

/** For injection into another Assistant tab's own turn — excludes that tab's own slot. Returns
 *  '' when disabled or the pool (after exclusion) has nothing to show. */
export async function buildAssistantMemoryDigestForTab(tabId: string): Promise<string> {
  const settings = await loadSettings()
  if (settings.assistantMemorySize === 'disabled') return ''
  const pool = await withPool(async (p) => ({ result: p }))
  return formatDigest(pool.slots, pool.rollup, tabId)
}

/** For `read_memory('assistant')` — no exclusion, since any tab kind can call this on demand. */
export async function buildFullAssistantMemoryDigest(): Promise<string> {
  const settings = await loadSettings()
  if (settings.assistantMemorySize === 'disabled') return ''
  const pool = await withPool(async (p) => ({ result: p }))
  return formatDigest(pool.slots, pool.rollup)
}

// ---------- Viewer support ----------

export async function listAssistantMemory(): Promise<AssistantMemoryPool> {
  return withPool(async (p) => ({ result: p }))
}

export async function deleteAssistantMemorySlot(tabId: string): Promise<AssistantMemoryPool> {
  return withPool(async (p) => {
    const next: AssistantMemoryPool = { slots: p.slots.filter((s) => s.tabId !== tabId), rollup: p.rollup }
    return { pool: next, result: next }
  })
}

export async function clearAssistantMemoryRollup(): Promise<AssistantMemoryPool> {
  return withPool(async (p) => {
    const next: AssistantMemoryPool = { slots: p.slots, rollup: null }
    return { pool: next, result: next }
  })
}

export async function clearAllAssistantMemory(): Promise<AssistantMemoryPool> {
  return withPool(async () => {
    const next = emptyPool()
    return { pool: next, result: next }
  })
}
