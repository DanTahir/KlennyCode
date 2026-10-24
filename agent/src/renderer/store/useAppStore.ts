import { create } from 'zustand'
import type {
  AgentStreamEvent,
  AppSettings,
  ArchivedTabSession,
  ChatMessage,
  ContentBlock,
  ImageModelInfo,
  VideoModelInfo,
  IndexStatus,
  ModelInfo,
  PendingAction,
  PendingQuestion,
  PlanArtifact,
  ShellInfo,
  SkillSummary,
  SubagentRun,
  TabSession,
  ToolCallBlock,
  UpdateStatusEvent
} from '@shared/types'
import { dropWritingPlaceholders } from '@shared/toolWriting'
import type { ModelWaitingInfo } from '@shared/types'

type ModelWaitingByTab = Record<string, { messageId: string; info: ModelWaitingInfo }>

/** Drops a tab's "waiting on the model" status. Returns {} (no state change) when there is none,
 *  so the hot per-token text_delta path doesn't allocate a new record on every delta. */
function clearModelWaiting(modelWaiting: ModelWaitingByTab, tabId: string): { modelWaiting?: ModelWaitingByTab } {
  if (!modelWaiting[tabId]) return {}
  const next = { ...modelWaiting }
  delete next[tabId]
  return { modelWaiting: next }
}

/** Replaces a single message in a single tab, leaving every other tab and message object
 *  untouched so memoized components for unchanged messages skip re-rendering. Searches from the
 *  end because the message being streamed into is almost always the last one. Returns the
 *  ORIGINAL `tabs` reference when nothing changed, so callers can skip set() entirely. */
function updateMessage(
  tabs: TabSession[],
  tabId: string,
  messageId: string,
  fn: (m: ChatMessage) => ChatMessage
): TabSession[] {
  const tabIdx = tabs.findIndex((t) => t.id === tabId)
  if (tabIdx < 0) return tabs
  const tab = tabs[tabIdx]
  let msgIdx = -1
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    if (tab.messages[i].id === messageId) {
      msgIdx = i
      break
    }
  }
  if (msgIdx < 0) return tabs
  const prev = tab.messages[msgIdx]
  const next = fn(prev)
  if (next === prev) return tabs
  const messages = tab.messages.slice()
  messages[msgIdx] = next
  const out = tabs.slice()
  out[tabIdx] = { ...tab, messages }
  return out
}

type DeltaKind = 'text' | 'thinking'

interface BufferedDelta {
  tabId: string
  messageId: string
  kind: DeltaKind
  text: string
}

/** Pending text/thinking deltas, coalesced per (tab, message, kind). Streaming at many tokens/sec
 *  used to trigger one store update — and one React render pass — per token; batching them into
 *  a single update every DELTA_FLUSH_MS keeps the renderer responsive. Map preserves insertion
 *  order, so blocks are created in the same order the deltas first arrived. */
const deltaBuffer = new Map<string, BufferedDelta>()
let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null
/** setTimeout rather than requestAnimationFrame so buffered text still lands while the window is
 *  hidden/minimized (rAF is paused there, which would stall the transcript until refocus). */
const DELTA_FLUSH_MS = 32

/** Appends to the first block of the given type, or pushes a new one — same semantics as the
 *  original per-delta path. */
function appendTextBlock(m: ChatMessage, kind: DeltaKind, text: string): ChatMessage {
  const blocks = [...m.blocks]
  const idx = blocks.findIndex((b) => b.type === kind)
  if (idx >= 0) {
    const b = blocks[idx] as { type: DeltaKind; text: string }
    blocks[idx] = { type: kind, text: b.text + text }
  } else {
    blocks.push({ type: kind, text } as ContentBlock)
  }
  return { ...m, blocks }
}

/** Applies every buffered delta in ONE set() call. Also called synchronously before any other
 *  stream event so that event ordering (e.g. text followed by tool_call_start) is preserved. */
function flushDeltaBuffer(get: () => AppState, setPartial: (p: Partial<AppState>) => void): void {
  if (deltaFlushTimer !== null) {
    clearTimeout(deltaFlushTimer)
    deltaFlushTimer = null
  }
  if (deltaBuffer.size === 0) return
  const entries = [...deltaBuffer.values()]
  deltaBuffer.clear()
  const state = get()
  let tabs = state.tabs
  let modelWaiting = state.modelWaiting
  for (const d of entries) {
    tabs = updateMessage(tabs, d.tabId, d.messageId, (m) => appendTextBlock(m, d.kind, d.text))
    const cleared = clearModelWaiting(modelWaiting, d.tabId)
    if (cleared.modelWaiting) modelWaiting = cleared.modelWaiting
  }
  const patch: Partial<AppState> = {}
  if (tabs !== state.tabs) patch.tabs = tabs
  if (modelWaiting !== state.modelWaiting) patch.modelWaiting = modelWaiting
  if (patch.tabs || patch.modelWaiting) setPartial(patch)
}

/** A plan opened as a tab in the main tab bar (client-side only — plans themselves live on disk). */
export interface OpenPlanTab {
  slug: string
  /** the chat tab that was active when this plan was opened/created; "Approve" returns here */
  originTabId: string | null
}

interface AppState {
  settings: AppSettings | null
  workspace: string | null
  /** Data URL of the user's custom app icon (sidebar/welcome screen), or null to use the
   *  bundled default. Loaded once at startup and refreshed after upload/reset in Settings. */
  customIconUrl: string | null
  setCustomIconUrl: (url: string | null) => void
  /** Data URL of the user's custom "AI is working" animation, or null to use the bundled
   *  default klenny.gif. */
  customRunningGifUrl: string | null
  setCustomRunningGifUrl: (url: string | null) => void
  models: ModelInfo[]
  /** Image-generation model catalog (OpenRouter's `/images/models`), kept separate from `models`
   *  because it's a different shape entirely — see KlennyApi.listImageModels. */
  imageModels: ImageModelInfo[]
  /** Video-generation model catalog (OpenRouter's `/videos/models`) — see KlennyApi.listVideoModels. */
  videoModels: VideoModelInfo[]
  shells: ShellInfo[]
  tabs: TabSession[]
  activeTabId: string | null
  pendingActions: PendingAction[]
  pendingQuestions: PendingQuestion[]
  subagentRuns: SubagentRun[]
  plans: PlanArtifact[]
  openPlanTabs: OpenPlanTab[]
  activePlanSlug: string | null
  history: ArchivedTabSession[]
  /** Closed Assistant tabs — separate, workspace-independent history from `history` above (see
   *  SessionStore.getAssistantHistory in the main process). */
  assistantHistory: ArchivedTabSession[]
  skills: SkillSummary[]
  panel: 'chat' | 'settings' | 'help' | 'skills' | 'memory' | 'plans' | 'history' | 'cost-report' | 'pawprints'
  /** Set by the agent's open_settings_panel tool (via IPC) to scroll/focus a specific Settings
   *  section once the panel is shown — e.g. 'integrations' when the user asks to connect
   *  Gmail/Discord. Cleared by SettingsPanel after it scrolls to the section. */
  settingsFocusSection: string | null
  setSettingsFocusSection: (section: string | null) => void
  terminalOpen: boolean
  terminalHeight: number
  setTerminalOpen: (open: boolean) => void
  toggleTerminal: () => void
  setTerminalHeight: (h: number) => void
  streamingTabIds: Set<string>
  /** Tabs currently running context compaction (summarization request in flight). Drives the
   *  "Compacting context" indicator — that step emits no other stream output for many seconds,
   *  so without this the app looks frozen. Cleared by `compaction_end`, with `turn_end`/`error`
   *  as backstops. */
  compactingTabIds: Set<string>
  /** Per tab: the in-flight model request has gone quiet (see ModelWaitingInfo). Drives the
   *  "Waiting on the model" indicator, so a provider stall looks different from a working stream.
   *  Set by `model_waiting`, cleared by its null form and, as backstops, by text/thinking output,
   *  message_start/message_end, error and turn_end. */
  modelWaiting: ModelWaitingByTab
  tabErrors: Record<string, string>
  /** Tabs whose turn stopped early (checkpoint step count reached, or the hard safety ceiling
   *  was hit) and are waiting for the user to click Continue. Cleared as soon as a new
   *  message_start comes in for that tab (i.e. the turn actually resumed). */
  pausedTabs: Record<string, { reason: 'checkpoint' | 'hard_limit'; stepsCompleted: number }>
  updateStatus: UpdateStatusEvent | null
  setUpdateStatus: (e: UpdateStatusEvent) => void
  updateSupported: boolean
  setUpdateSupported: (v: boolean) => void
  indexStatus: IndexStatus | null
  setIndexStatus: (s: IndexStatus | null) => void
  setSettings: (s: AppSettings) => void
  setWorkspace: (w: string | null) => void
  setModels: (m: ModelInfo[]) => void
  setImageModels: (m: ImageModelInfo[]) => void
  setVideoModels: (m: VideoModelInfo[]) => void
  setShells: (s: ShellInfo[]) => void
  setTabs: (tabs: TabSession[]) => void
  setActiveTab: (id: string) => void
  upsertTab: (tab: TabSession) => void
  applyStreamEvent: (e: AgentStreamEvent) => void
  setPanel: (p: AppState['panel']) => void
  setSkills: (s: SkillSummary[]) => void
  setPlans: (p: PlanArtifact[]) => void
  upsertPlan: (p: PlanArtifact) => void
  openPlanTab: (slug: string, originTabId: string | null) => void
  closePlanTab: (slug: string) => void
  setHistory: (h: ArchivedTabSession[]) => void
  setAssistantHistory: (h: ArchivedTabSession[]) => void
  hideSubagentRun: (id: string) => void
  clearFinishedSubagentRuns: (parentTabId: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: null,
  workspace: null,
  customIconUrl: null,
  setCustomIconUrl: (customIconUrl) => set({ customIconUrl }),
  customRunningGifUrl: null,
  setCustomRunningGifUrl: (customRunningGifUrl) => set({ customRunningGifUrl }),
  models: [],
  imageModels: [],
  videoModels: [],
  shells: [],
  tabs: [],
  activeTabId: null,
  pendingActions: [],
  pendingQuestions: [],
  subagentRuns: [],
  plans: [],
  openPlanTabs: [],
  activePlanSlug: null,
  history: [],
  assistantHistory: [],
  skills: [],
  panel: 'chat',
  settingsFocusSection: null,
  setSettingsFocusSection: (settingsFocusSection) => set({ settingsFocusSection }),
  terminalOpen: false,
  terminalHeight: 260,
  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalHeight: (terminalHeight) => set({ terminalHeight: Math.max(120, Math.min(720, terminalHeight)) }),
  streamingTabIds: new Set(),
  compactingTabIds: new Set(),
  modelWaiting: {},
  tabErrors: {},
  pausedTabs: {},
  updateStatus: null,
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  updateSupported: false,
  setUpdateSupported: (updateSupported) => set({ updateSupported }),
  indexStatus: null,
  setIndexStatus: (indexStatus) => set({ indexStatus }),
  setSettings: (settings) => set({ settings }),
  setWorkspace: (workspace) => set({ workspace, openPlanTabs: [], activePlanSlug: null }),
  setModels: (models) => set({ models }),
  setImageModels: (imageModels) => set({ imageModels }),
  setVideoModels: (videoModels) => set({ videoModels }),
  setShells: (shells) => set({ shells }),
  setTabs: (tabs) =>
    set((s) => {
      const liveIds = new Set(tabs.map((t) => t.id))
      // Prune subagentRuns whose parent tab no longer exists (e.g. it was closed) so they don't
      // accumulate in memory for the lifetime of the app.
      const subagentRuns = s.subagentRuns.filter((r) => liveIds.has(r.parentTabId))
      return {
        tabs,
        subagentRuns,
        activeTabId: s.activeTabId && tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? null
      }
    }),
  setActiveTab: (id) => set({ activeTabId: id, activePlanSlug: null }),
  upsertTab: (tab) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tab.id ? tab : t))
    })),
  setPanel: (panel) => set({ panel }),
  setSkills: (skills) => set({ skills }),
  setPlans: (plans) => set({ plans }),
  upsertPlan: (plan) =>
    set((s) => {
      const idx = s.plans.findIndex((p) => p.slug === plan.slug)
      const plans = idx >= 0 ? s.plans.map((p, i) => (i === idx ? plan : p)) : [plan, ...s.plans]
      return { plans }
    }),
  openPlanTab: (slug, originTabId) =>
    set((s) => {
      const existing = s.openPlanTabs.find((t) => t.slug === slug)
      const openPlanTabs = existing
        ? s.openPlanTabs
        : [...s.openPlanTabs, { slug, originTabId }]
      return { openPlanTabs, activePlanSlug: slug, panel: 'chat' }
    }),
  closePlanTab: (slug) =>
    set((s) => {
      const openPlanTabs = s.openPlanTabs.filter((t) => t.slug !== slug)
      const activePlanSlug = s.activePlanSlug === slug ? null : s.activePlanSlug
      return { openPlanTabs, activePlanSlug }
    }),
  setHistory: (history) => set({ history }),
  setAssistantHistory: (assistantHistory) => set({ assistantHistory }),
  hideSubagentRun: (id) =>
    set((s) => ({
      subagentRuns: s.subagentRuns.map((r) => (r.id === id ? { ...r, hidden: true } : r))
    })),
  clearFinishedSubagentRuns: (parentTabId) =>
    set((s) => ({
      subagentRuns: s.subagentRuns.map((r) =>
        r.parentTabId === parentTabId && r.status !== 'running' ? { ...r, hidden: true } : r
      )
    })),
  applyStreamEvent: (e) => {
    const setPartial = (p: Partial<AppState>) => set(p)
    if (e.type === 'text_delta' || e.type === 'thinking_delta') {
      const kind: DeltaKind = e.type === 'text_delta' ? 'text' : 'thinking'
      const key = `${e.tabId}\u0000${e.messageId}\u0000${kind}`
      const existing = deltaBuffer.get(key)
      if (existing) existing.text += e.delta
      else deltaBuffer.set(key, { tabId: e.tabId, messageId: e.messageId, kind, text: e.delta })
      if (deltaFlushTimer === null) {
        deltaFlushTimer = setTimeout(() => flushDeltaBuffer(get, setPartial), DELTA_FLUSH_MS)
      }
      return
    }
    // Any non-delta event must observe all text that streamed before it.
    flushDeltaBuffer(get, setPartial)
    const state = get()
    switch (e.type) {
      case 'user_message': {
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId ? { ...t, messages: [...t.messages, e.message] } : t
        )
        const pausedTabs = { ...state.pausedTabs }
        delete pausedTabs[e.tabId]
        set({ tabs, tabErrors: { ...state.tabErrors, [e.tabId]: '' }, pausedTabs })
        break
      }
      case 'message_start': {
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId ? { ...t, messages: [...t.messages, e.message] } : t
        )
        const streaming = new Set(state.streamingTabIds)
        streaming.add(e.tabId)
        const pausedTabs = { ...state.pausedTabs }
        delete pausedTabs[e.tabId]
        set({ tabs, streamingTabIds: streaming, pausedTabs, ...clearModelWaiting(state.modelWaiting, e.tabId) })
        break
      }
      // The model is still streaming this call's arguments. Upserts a placeholder block so a long
      // write_file/multi_write payload shows live progress instead of looking like a frozen app;
      // `tool_call_start` below swaps it for the real block once the arguments are complete.
      case 'tool_call_writing': {
        const tabs = updateMessage(state.tabs, e.tabId, e.messageId, (m) => {
          const idx = m.blocks.findIndex((b) => b.type === 'tool_call' && b.id === e.toolCallId)
          const placeholder: ToolCallBlock = {
            type: 'tool_call',
            id: e.toolCallId,
            toolName: e.toolName || 'tool call',
            args: {},
            status: 'writing',
            writingChars: e.charsSoFar,
            writingLabel: e.label
          }
          if (idx < 0) return { ...m, blocks: [...m.blocks, placeholder] }
          // Never let a late/reordered writing event regress a call that already has real
          // arguments or has started executing.
          if ((m.blocks[idx] as ToolCallBlock).status !== 'writing') return m
          const blocks = [...m.blocks]
          blocks[idx] = placeholder
          return { ...m, blocks }
        })
        if (tabs !== state.tabs) set({ tabs })
        break
      }
      // Arguments finished: replace the placeholder with the same id IN PLACE, so the card keeps
      // its position in the transcript rather than disappearing and reappearing at the bottom.
      case 'tool_call_start': {
        const tabs = updateMessage(state.tabs, e.tabId, e.messageId, (m) => {
          const idx = m.blocks.findIndex(
            (b) => b.type === 'tool_call' && b.id === e.block.id && b.status === 'writing'
          )
          if (idx < 0) return { ...m, blocks: [...m.blocks, e.block] }
          const blocks = [...m.blocks]
          blocks[idx] = e.block
          return { ...m, blocks }
        })
        if (tabs !== state.tabs) set({ tabs })
        break
      }
      // Lifecycle transition with no result yet ('queued' -> 'running'). Guarded on `!b.result` so
      // it can never overwrite an already-finished call if events arrive out of order.
      case 'tool_call_status': {
        const tabs = updateMessage(state.tabs, e.tabId, e.messageId, (m) => {
          const blocks = m.blocks.map((b) =>
            b.type === 'tool_call' && b.id === e.toolCallId && !b.result
              ? ({ ...b, status: e.status } as ToolCallBlock)
              : b
          )
          return { ...m, blocks }
        })
        if (tabs !== state.tabs) set({ tabs })
        break
      }
      case 'tool_call_progress': {
        const tabs = updateMessage(state.tabs, e.tabId, e.messageId, (m) => {
          const blocks = m.blocks.map((b) =>
            b.type === 'tool_call' && b.id === e.toolCallId ? { ...b, progressMessage: e.message } : b
          )
          return { ...m, blocks }
        })
        if (tabs !== state.tabs) set({ tabs })
        break
      }
      case 'tool_call_result': {
        // Look up the original block before we overwrite it, so we know which tool this was.
        const sourceTab = state.tabs.find((t) => t.id === e.tabId)
        const sourceMessage = sourceTab?.messages.find((m) => m.id === e.messageId)
        const sourceBlock = sourceMessage?.blocks.find(
          (b): b is ToolCallBlock => b.type === 'tool_call' && b.id === e.toolCallId
        )

        const tabs = updateMessage(state.tabs, e.tabId, e.messageId, (m) => {
          const blocks = m.blocks.map((b) => {
            if (b.type === 'tool_call' && b.id === e.toolCallId) {
              return { ...b, status: e.status, result: e.result } as ToolCallBlock
            }
            return b
          })
          return { ...m, blocks }
        })
        if (tabs !== state.tabs) set({ tabs })

        if (sourceBlock?.toolName === 'save_plan' && e.status === 'success') {
          const plan = (e.result?.data as { plan?: PlanArtifact } | undefined)?.plan
          if (plan) {
            get().upsertPlan(plan)
            get().openPlanTab(plan.slug, e.tabId)
          }
        }
        break
      }
      case 'message_end': {
        let tabs = updateMessage(state.tabs, e.tabId, e.messageId, (m) => ({ ...m, usage: e.usage ?? m.usage }))
        // A stream that ended mid-arguments (truncation, provider error) leaves a placeholder
        // standing; drop it rather than leave a card pulsing "writing…" forever.
        const tabIdx = tabs.findIndex((t) => t.id === e.tabId)
        if (tabIdx >= 0) {
          const t = tabs[tabIdx]
          const messages = dropWritingPlaceholders(t.messages)
          if (messages !== t.messages) {
            // updateMessage already returned a fresh array if it changed anything; only copy when
            // we would otherwise mutate the store's current array.
            if (tabs === state.tabs) tabs = tabs.slice()
            tabs[tabIdx] = { ...t, messages }
          }
        }
        set({ tabs, ...clearModelWaiting(state.modelWaiting, e.tabId) })
        break
      }
      // The guard flags the message rather than removing it — the user still needs to see exactly
      // what was claimed in order to judge it (see MessageBubble's verification badge).
      case 'fabrication_flagged': {
        const tabs = updateMessage(state.tabs, e.tabId, e.messageId, (m) => ({
          ...m,
          verification: { status: e.status, findings: e.findings }
        }))
        if (tabs !== state.tabs) set({ tabs })
        break
      }
      case 'error': {
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId ? { ...t, messages: dropWritingPlaceholders(t.messages) } : t
        )
        const compacting = new Set(state.compactingTabIds)
        compacting.delete(e.tabId)
        set({
          tabs,
          compactingTabIds: compacting,
          tabErrors: { ...state.tabErrors, [e.tabId]: e.message },
          ...clearModelWaiting(state.modelWaiting, e.tabId)
        })
        break
      }
      case 'turn_end': {
        const streaming = new Set(state.streamingTabIds)
        streaming.delete(e.tabId)
        // Backstop for the abort path: Stop can unwind a turn mid-arguments without a
        // message_end, which would otherwise strand a "writing…" card in the transcript.
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId ? { ...t, messages: dropWritingPlaceholders(t.messages) } : t
        )
        // Same backstop reasoning as the writing placeholders above: a turn can unwind without
        // the compaction bracket closing cleanly, and a stuck spinner is worse than none.
        const compacting = new Set(state.compactingTabIds)
        compacting.delete(e.tabId)
        set({
          tabs,
          streamingTabIds: streaming,
          compactingTabIds: compacting,
          ...clearModelWaiting(state.modelWaiting, e.tabId)
        })
        break
      }
      case 'turn_paused': {
        set({
          pausedTabs: {
            ...state.pausedTabs,
            [e.tabId]: { reason: e.reason, stepsCompleted: e.stepsCompleted }
          }
        })
        break
      }
      case 'pending_action':
        set({ pendingActions: [...state.pendingActions, e.action] })
        break
      case 'pending_action_resolved':
        set({ pendingActions: state.pendingActions.filter((a) => a.id !== e.actionId) })
        break
      case 'pending_question':
        set({ pendingQuestions: [...state.pendingQuestions, e.question] })
        break
      case 'pending_question_resolved':
        set({ pendingQuestions: state.pendingQuestions.filter((q) => q.id !== e.questionId) })
        break
      case 'subagent_update': {
        const existing = state.subagentRuns.findIndex((r) => r.id === e.run.id)
        const runs = [...state.subagentRuns]
        // The server never knows about client-side dismissal; preserve it across updates.
        if (existing >= 0) runs[existing] = { ...e.run, hidden: runs[existing].hidden }
        else runs.push(e.run)
        set({ subagentRuns: runs })
        break
      }
      case 'compaction_start': {
        const compacting = new Set(state.compactingTabIds)
        compacting.add(e.tabId)
        set({ compactingTabIds: compacting })
        break
      }
      case 'compaction_end': {
        const compacting = new Set(state.compactingTabIds)
        compacting.delete(e.tabId)
        set({ compactingTabIds: compacting })
        break
      }
      case 'model_waiting': {
        // Subagent runs forward their events too but aren't in `tabs`; tracking them would only
        // leak entries that no turn_end ever clears.
        if (!state.tabs.some((t) => t.id === e.tabId)) break
        if (e.waiting) {
          set({ modelWaiting: { ...state.modelWaiting, [e.tabId]: { messageId: e.messageId, info: e.waiting } } })
        } else {
          set(clearModelWaiting(state.modelWaiting, e.tabId))
        }
        break
      }
      case 'compaction': {
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId
            ? { ...t, compactedThroughMessageId: e.compactedThroughMessageId, compactionSummary: e.summary }
            : t
        )
        set({ tabs })
        break
      }
      case 'spend_update': {
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId ? { ...t, totalCostUsd: e.totalCostUsd, totalSavingsUsd: e.totalSavingsUsd } : t
        )
        set({ tabs })
        break
      }
      case 'tab_upserted': {
        const exists = state.tabs.some((t) => t.id === e.tab.id)
        const tabs = exists ? state.tabs.map((t) => (t.id === e.tab.id ? e.tab : t)) : [...state.tabs, e.tab]
        set({ tabs })
        break
      }
      case 'history_entry_removed': {
        set({
          history: state.history.filter((t) => t.id !== e.tabId),
          assistantHistory: state.assistantHistory.filter((t) => t.id !== e.tabId)
        })
        break
      }
      case 'index_progress': {
        // Patches the fields this event actually carries; `enabled`/`backend`/`embeddingsModel`/
        // `lastUpdatedAt` come from the one-shot getIndexStatus() IPC call on Settings mount and
        // are preserved here rather than clobbered, since this event never includes them.
        const prev = state.indexStatus
        const next: IndexStatus = {
          enabled: prev?.enabled ?? true,
          phase: e.phase,
          filesTotal: e.filesTotal ?? prev?.filesTotal ?? 0,
          filesDone: e.filesDone ?? prev?.filesDone ?? 0,
          lastUpdatedAt: e.phase === 'idle' ? Date.now() : prev?.lastUpdatedAt ?? null,
          message: e.message,
          backend: prev?.backend ?? 'local',
          embeddingsModel: prev?.embeddingsModel ?? null
        }
        set({ indexStatus: next })
        break
      }
      default:
        break
    }
  }
}))

export function getActiveTab(tabs: TabSession[], activeTabId: string | null): TabSession | null {
  return tabs.find((t) => t.id === activeTabId) ?? tabs[0] ?? null
}
