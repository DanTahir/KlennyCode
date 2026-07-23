import type {
  AgentMode,
  ApprovalDecision,
  AppSettings,
  ArchivedTabSession,
  CostReport,
  IndexStatus,
  ModelInfo,
  PlanArtifact,
  QuestionAnswer,
  ScheduledTask,
  ShellInfo,
  SkillSummary,
  SubagentTypeSummary,
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

  settingsNavigate: 'settings:navigate',

  historyList: 'history:list',
  historyReopen: 'history:reopen',
  historyDelete: 'history:delete',

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
  schedulerDelete: 'scheduler:delete'
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

  /** Renderer-side listener for the agent's open_settings_panel tool — switches to Settings and
   *  focuses the given section (e.g. 'integrations'). */
  onSettingsNavigate: (cb: (section: string) => void) => () => void

  listHistory: () => Promise<ArchivedTabSession[]>
  reopenHistory: (tabId: string) => Promise<TabSession | null>
  deleteHistory: (tabId: string) => Promise<ArchivedTabSession[]>

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
    task: Pick<ScheduledTask, 'name' | 'prompt' | 'schedule' | 'targetWorkspace' | 'maxCostUsd'>
  ) => Promise<ScheduledTask>
  updateScheduledTask: (id: string, patch: Partial<ScheduledTask>) => Promise<ScheduledTask | null>
  deleteScheduledTask: (id: string) => Promise<void>

  onStreamEvent: (cb: (event: unknown) => void) => () => void
  onUpdateStatus: (cb: (event: UpdateStatusEvent) => void) => () => void
}
