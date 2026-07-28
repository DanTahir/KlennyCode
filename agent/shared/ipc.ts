import type {
  AgentMode,
  ApprovalDecision,
  AppSettings,
  ArchivedTabSession,
  AssistantMemoryPool,
  CostReport,
  IndexStatus,
  ModelInfo,
  PlanArtifact,
  QuestionAnswer,
  ScheduledTask,
  ShellInfo,
  SkillSummary,
  SubagentTypeSummary,
  TabApprovalMode,
  TabSession,
  UpdateStatusEvent
} from './types'

/** Channel names used for ipcRenderer.invoke / ipcMain.handle request-response calls. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  setApiKey: 'settings:setApiKey',
  clearApiKey: 'settings:clearApiKey',

  workspaceOpen: 'workspace:open',
  workspaceGet: 'workspace:get',

  documentsDirectoryPick: 'documentsDirectory:pick',

  modelsList: 'models:list',
  shellsList: 'shells:list',

  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalDispose: 'terminal:dispose',

  tabsList: 'tabs:list',
  tabCreate: 'tabs:create',
  tabCreateAssistant: 'tabs:createAssistant',
  tabClose: 'tabs:close',
  tabSetMode: 'tabs:setMode',
  tabSetModel: 'tabs:setModel',
  tabSetApprovalMode: 'tabs:setApprovalMode',

  settingsNavigate: 'settings:navigate',

  historyList: 'history:list',
  historyReopen: 'history:reopen',
  historyDelete: 'history:delete',

  assistantHistoryList: 'assistantHistory:list',
  assistantHistoryReopen: 'assistantHistory:reopen',
  assistantHistoryDelete: 'assistantHistory:delete',

  sendMessage: 'chat:sendMessage',
  stopGeneration: 'chat:stop',
  continueTurn: 'chat:continue',

  resolveApproval: 'approval:resolve',
  resolveQuestion: 'question:resolve',

  skillsList: 'skills:list',
  skillRead: 'skills:read',
  skillWrite: 'skills:write',

  subagentsList: 'subagents:list',
  subagentWrite: 'subagents:write',

  plansList: 'plans:list',
  planRead: 'plans:read',

  memoryRead: 'memory:read',
  memoryWrite: 'memory:write',

  assistantMemoryList: 'assistantMemory:list',
  assistantMemoryDeleteSlot: 'assistantMemory:deleteSlot',
  assistantMemoryClearRollup: 'assistantMemory:clearRollup',
  assistantMemoryClearAll: 'assistantMemory:clearAll',

  soulRead: 'soul:read',
  soulWrite: 'soul:write',
  soulReset: 'soul:reset',

  checkpointRevert: 'checkpoint:revert',

  pineconeSetKey: 'codeindex:setPineconeKey',
  pineconeClearKey: 'codeindex:clearPineconeKey',
  indexRebuild: 'codeindex:rebuild',
  indexDelete: 'codeindex:delete',
  indexStatus: 'codeindex:status',

  appVersion: 'app:version',
  updateSupported: 'app:updateSupported',
  checkForUpdates: 'app:checkForUpdates',
  installUpdate: 'app:installUpdate',

  costReportGet: 'costReport:get',
  costReportReset: 'costReport:reset',

  gmailConnect: 'gmail:connect',
  gmailDisconnect: 'gmail:disconnect',
  discordConnect: 'discord:connect',
  discordDisconnect: 'discord:disconnect',
  discordStatusGet: 'discord:statusGet',
  onDiscordStatus: 'discord:onStatus',

  schedulerList: 'scheduler:list',
  schedulerCreate: 'scheduler:create',
  schedulerUpdate: 'scheduler:update',
  schedulerDelete: 'scheduler:delete',

  brandingGetIcon: 'branding:getIcon',
  brandingSetIcon: 'branding:setIcon',
  brandingClearIcon: 'branding:clearIcon',
  brandingGetRunningGif: 'branding:getRunningGif',
  brandingSetRunningGif: 'branding:setRunningGif',
  brandingClearRunningGif: 'branding:clearRunningGif',
  brandingResetAll: 'branding:resetAll'
} as const

export interface SendMessagePayload {
  tabId: string
  text: string
  images?: string[] // data URLs
}

export interface KlennyApi {
  getSettings: () => Promise<AppSettings>
  setSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
  setApiKey: (key: string) => Promise<void>
  clearApiKey: () => Promise<void>

  openWorkspace: () => Promise<string | null>
  getWorkspace: () => Promise<string | null>

  /** Opens a native folder-picker for AppSettings.documentsDirectory (the Assistant-tab file
   *  sandbox root — see documentsDir.ts). Returns the newly-picked absolute path, or null if the
   *  user canceled the dialog. */
  pickDocumentsDirectory: () => Promise<string | null>

  listModels: (forceRefresh?: boolean) => Promise<ModelInfo[]>
  listShells: () => Promise<ShellInfo[]>

  createTerminal: (cols: number, rows: number) => Promise<{ id: string; shellName: string }>
  writeTerminal: (id: string, data: string) => Promise<void>
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
  disposeTerminal: (id: string) => Promise<void>
  onTerminalData: (cb: (id: string, data: string) => void) => () => void
  onTerminalExit: (cb: (id: string, exitCode: number) => void) => () => void

  listTabs: () => Promise<TabSession[]>
  createTab: () => Promise<TabSession>
  /** Always creates a brand-new, ephemeral Assistant tab — never focuses/reuses an existing one (v1 design decision). */
  createAssistantTab: () => Promise<TabSession>
  closeTab: (tabId: string) => Promise<TabSession[]>
  setTabMode: (tabId: string, mode: AgentMode) => Promise<void>
  setTabModel: (tabId: string, model: string) => Promise<void>
  /** Sets a tab's own approval-mode override, shown in the dropdown next to Send/Stop.
   *  'default' clears the override so the tab follows AppSettings.approvalMode again. */
  setTabApprovalMode: (tabId: string, mode: TabApprovalMode) => Promise<void>

  /** Renderer-side listener for the agent's open_settings_panel tool — switches to Settings and
   *  focuses the given section (e.g. 'integrations'). */
  onSettingsNavigate: (cb: (section: string) => void) => () => void

  listHistory: () => Promise<ArchivedTabSession[]>
  reopenHistory: (tabId: string) => Promise<TabSession | null>
  deleteHistory: (tabId: string) => Promise<ArchivedTabSession[]>

  /** Closed Assistant tabs — a separate, workspace-independent history from listHistory's
   *  per-workspace project-tab history (see SessionStore.assistantHistoryFile). */
  listAssistantHistory: () => Promise<ArchivedTabSession[]>
  reopenAssistantHistory: (tabId: string) => Promise<TabSession | null>
  deleteAssistantHistory: (tabId: string) => Promise<ArchivedTabSession[]>

  sendMessage: (payload: SendMessagePayload) => Promise<void>
  stopGeneration: (tabId: string) => Promise<void>
  /** Resumes a turn that emitted `turn_paused` (checkpoint reached or hard limit hit) — continues
   *  agentLoop from the existing message state, no new user-message bubble. */
  continueTurn: (tabId: string) => Promise<void>

  resolveApproval: (actionId: string, decision: ApprovalDecision) => Promise<void>
  resolveQuestion: (questionId: string, answers: QuestionAnswer[]) => Promise<void>

  listSkills: () => Promise<SkillSummary[]>
  readSkill: (path: string) => Promise<string>
  writeSkill: (name: string, scope: 'project' | 'global', description: string, body: string) => Promise<void>

  listSubagentTypes: () => Promise<SubagentTypeSummary[]>
  writeSubagentType: (
    name: string,
    scope: 'project' | 'global',
    description: string,
    tools: string[] | 'all',
    model: string | undefined,
    body: string
  ) => Promise<void>

  listPlans: () => Promise<PlanArtifact[]>
  readPlan: (slug: string) => Promise<PlanArtifact | null>

  readMemory: (scope: 'project' | 'global') => Promise<string>
  writeMemory: (scope: 'project' | 'global', content: string) => Promise<void>

  /** Assistant-window shared, auto-compacting memory pool (see AssistantMemoryPool) — a single
   *  workspace-independent pool viewed/managed from the Memory panel. */
  listAssistantMemory: () => Promise<AssistantMemoryPool>
  deleteAssistantMemorySlot: (tabId: string) => Promise<AssistantMemoryPool>
  clearAssistantMemoryRollup: () => Promise<AssistantMemoryPool>
  clearAllAssistantMemory: () => Promise<AssistantMemoryPool>

  /** SOUL.md — user-editable agent personality, global across all projects (`~/.klenny/SOUL.md`). */
  readSoul: () => Promise<string>
  writeSoul: (content: string) => Promise<void>
  /** Overwrites SOUL.md with Klenny's built-in default personality and returns the new content. */
  resetSoul: () => Promise<string>

  revertCheckpoint: (checkpointId: string) => Promise<void>

  setPineconeKey: (key: string) => Promise<void>
  clearPineconeKey: () => Promise<void>
  rebuildIndex: () => Promise<void>
  deleteIndex: () => Promise<void>
  getIndexStatus: () => Promise<IndexStatus>

  getAppVersion: () => Promise<string>
  isUpdateSupported: () => Promise<boolean>
  checkForUpdates: () => Promise<void>
  installUpdate: () => Promise<void>

  getCostReport: () => Promise<CostReport>
  resetCostReport: () => Promise<CostReport>

  /** Starts the Gmail OAuth loopback flow: opens the system browser, listens on an auto-selected
   *  free port for the redirect, exchanges the code for tokens, and stores them encrypted.
   *  Resolves once connected (or rejects with a user-facing error message). */
  connectGmail: () => Promise<{ email: string }>
  disconnectGmail: () => Promise<void>

  connectDiscord: (botToken: string) => Promise<{ botTag: string }>
  disconnectDiscord: () => Promise<void>
  getDiscordStatus: () => Promise<{ connected: boolean; botTag: string | null; lastError: string | null }>
  onDiscordStatus: (cb: (status: { connected: boolean; botTag: string | null; lastError: string | null }) => void) => () => void

  listScheduledTasks: () => Promise<ScheduledTask[]>
  createScheduledTask: (
    task: Pick<ScheduledTask, 'name' | 'prompt' | 'schedule' | 'targetWorkspace' | 'maxCostUsd'> &
      Partial<Pick<ScheduledTask, 'maxRuns'>>
  ) => Promise<ScheduledTask>
  updateScheduledTask: (id: string, patch: Partial<ScheduledTask>) => Promise<ScheduledTask | null>
  deleteScheduledTask: (id: string) => Promise<void>

  /** Returns a data URL (or null if no custom icon is set) for the sidebar/welcome-screen icon. */
  getCustomIcon: () => Promise<string | null>
  /** dataUrl must be a `data:image/...;base64,...` string (PNG or JPEG) — applied immediately
   *  to the app icon, taskbar/dock icon, and tray. */
  setCustomIcon: (dataUrl: string) => Promise<AppSettings>
  clearCustomIcon: () => Promise<AppSettings>
  /** Returns a data URL (or null if no custom "AI is working" animation is set). */
  getCustomRunningGif: () => Promise<string | null>
  /** dataUrl must be a `data:image/gif;base64,...` or `data:image/webp;base64,...` string. */
  setCustomRunningGif: (dataUrl: string) => Promise<AppSettings>
  clearCustomRunningGif: () => Promise<AppSettings>
  /** Clears custom icon, custom running gif, and brandName in one call — used by the
   *  Settings → Appearance "Reset to defaults" button. */
  resetBranding: () => Promise<AppSettings>

  onStreamEvent: (cb: (event: unknown) => void) => () => void
  onUpdateStatus: (cb: (event: UpdateStatusEvent) => void) => () => void
}
