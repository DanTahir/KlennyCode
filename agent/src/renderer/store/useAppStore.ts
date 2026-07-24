import { create } from 'zustand'
import type {
  AgentStreamEvent,
  AppSettings,
  ArchivedTabSession,
  ChatMessage,
  ContentBlock,
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

/** A plan opened as a tab in the main tab bar (client-side only — plans themselves live on disk). */
export interface OpenPlanTab {
  slug: string
  /** the chat tab that was active when this plan was opened/created; "Approve" returns here */
  originTabId: string | null
}

interface AppState {
  settings: AppSettings | null
  workspace: string | null
  models: ModelInfo[]
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
  skills: SkillSummary[]
  panel: 'chat' | 'settings' | 'help' | 'skills' | 'memory' | 'plans' | 'history' | 'cost-report'
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
  hideSubagentRun: (id: string) => void
  clearFinishedSubagentRuns: (parentTabId: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  settings: null,
  workspace: null,
  models: [],
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
  setShells: (shells) => set({ shells }),
  setTabs: (tabs) =>
    set((s) => ({
      tabs,
      activeTabId: s.activeTabId && tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? null
    })),
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
        set({ tabs, streamingTabIds: streaming, pausedTabs })
        break
      }
      case 'text_delta':
      case 'thinking_delta': {
        const tabs = state.tabs.map((t) => {
          if (t.id !== e.tabId) return t
          const messages = t.messages.map((m) => {
            if (m.id !== e.messageId) return m
            const blocks = [...m.blocks]
            const type = e.type === 'text_delta' ? 'text' : 'thinking'
            const idx = blocks.findIndex((b) => b.type === type)
            if (idx >= 0) {
              const b = blocks[idx] as { type: 'text' | 'thinking'; text: string }
              blocks[idx] = { type, text: b.text + e.delta }
            } else {
              blocks.push({ type, text: e.delta } as ContentBlock)
            }
            return { ...m, blocks }
          })
          return { ...t, messages }
        })
        set({ tabs })
        break
      }
      case 'tool_call_start': {
        const tabs = state.tabs.map((t) => {
          if (t.id !== e.tabId) return t
          const messages = t.messages.map((m) =>
            m.id === e.messageId ? { ...m, blocks: [...m.blocks, e.block] } : m
          )
          return { ...t, messages }
        })
        set({ tabs })
        break
      }
      case 'tool_call_result': {
        // Look up the original block before we overwrite it, so we know which tool this was.
        const sourceTab = state.tabs.find((t) => t.id === e.tabId)
        const sourceMessage = sourceTab?.messages.find((m) => m.id === e.messageId)
        const sourceBlock = sourceMessage?.blocks.find(
          (b): b is ToolCallBlock => b.type === 'tool_call' && b.id === e.toolCallId
        )

        const tabs = state.tabs.map((t) => {
          if (t.id !== e.tabId) return t
          const messages = t.messages.map((m) => {
            if (m.id !== e.messageId) return m
            const blocks = m.blocks.map((b) => {
              if (b.type === 'tool_call' && b.id === e.toolCallId) {
                return { ...b, status: e.status, result: e.result } as ToolCallBlock
              }
              return b
            })
            return { ...m, blocks }
          })
          return { ...t, messages }
        })
        set({ tabs })

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
        const tabs = state.tabs.map((t) => {
          if (t.id !== e.tabId) return t
          const messages = t.messages.map((m) =>
            m.id === e.messageId ? { ...m, usage: e.usage ?? m.usage } : m
          )
          return { ...t, messages }
        })
        set({ tabs })
        break
      }
      case 'error':
        set({ tabErrors: { ...state.tabErrors, [e.tabId]: e.message } })
        break
      case 'turn_end': {
        const streaming = new Set(state.streamingTabIds)
        streaming.delete(e.tabId)
        set({ streamingTabIds: streaming })
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
        set({ history: state.history.filter((t) => t.id !== e.tabId) })
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
