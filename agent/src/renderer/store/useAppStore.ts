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
  history: ArchivedTabSession[]
  skills: SkillSummary[]
  panel: 'chat' | 'settings' | 'help' | 'skills' | 'memory' | 'plans' | 'history'
  streamingTabIds: Set<string>
  tabErrors: Record<string, string>
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
  setHistory: (h: ArchivedTabSession[]) => void
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
  history: [],
  skills: [],
  panel: 'chat',
  streamingTabIds: new Set(),
  tabErrors: {},
  updateStatus: null,
  setUpdateStatus: (updateStatus) => set({ updateStatus }),
  updateSupported: false,
  setUpdateSupported: (updateSupported) => set({ updateSupported }),
  indexStatus: null,
  setIndexStatus: (indexStatus) => set({ indexStatus }),
  setSettings: (settings) => set({ settings }),
  setWorkspace: (workspace) => set({ workspace }),
  setModels: (models) => set({ models }),
  setShells: (shells) => set({ shells }),
  setTabs: (tabs) =>
    set((s) => ({
      tabs,
      activeTabId: s.activeTabId && tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : tabs[0]?.id ?? null
    })),
  setActiveTab: (id) => set({ activeTabId: id }),
  upsertTab: (tab) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tab.id ? tab : t))
    })),
  setPanel: (panel) => set({ panel }),
  setSkills: (skills) => set({ skills }),
  setPlans: (plans) => set({ plans }),
  setHistory: (history) => set({ history }),
  applyStreamEvent: (e) => {
    const state = get()
    switch (e.type) {
      case 'user_message': {
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId ? { ...t, messages: [...t.messages, e.message] } : t
        )
        set({ tabs, tabErrors: { ...state.tabErrors, [e.tabId]: '' } })
        break
      }
      case 'message_start': {
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId ? { ...t, messages: [...t.messages, e.message] } : t
        )
        const streaming = new Set(state.streamingTabIds)
        streaming.add(e.tabId)
        set({ tabs, streamingTabIds: streaming })
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
        if (existing >= 0) runs[existing] = e.run
        else runs.push(e.run)
        set({ subagentRuns: runs })
        break
      }
      case 'compaction': {
        const tabs = state.tabs.map((t) =>
          t.id === e.tabId ? { ...t, compactedThroughMessageId: e.summaryMessageId } : t
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
