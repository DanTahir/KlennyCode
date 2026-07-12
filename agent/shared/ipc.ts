import type {
  AgentMode,
  ApprovalDecision,
  AppSettings,
  ArchivedTabSession,
  ModelInfo,
  PlanArtifact,
  QuestionAnswer,
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

  tabsList: 'tabs:list',
  tabCreate: 'tabs:create',
  tabClose: 'tabs:close',
  tabSetMode: 'tabs:setMode',
  tabSetModel: 'tabs:setModel',

  historyList: 'history:list',
  historyReopen: 'history:reopen',
  historyDelete: 'history:delete',

  sendMessage: 'chat:sendMessage',
  stopGeneration: 'chat:stop',

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

  appVersion: 'app:version',
  updateSupported: 'app:updateSupported',
  checkForUpdates: 'app:checkForUpdates',
  installUpdate: 'app:installUpdate'
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

  listTabs: () => Promise<TabSession[]>
  createTab: () => Promise<TabSession>
  closeTab: (tabId: string) => Promise<TabSession[]>
  setTabMode: (tabId: string, mode: AgentMode) => Promise<void>
  setTabModel: (tabId: string, model: string) => Promise<void>

  listHistory: () => Promise<ArchivedTabSession[]>
  reopenHistory: (tabId: string) => Promise<TabSession | null>
  deleteHistory: (tabId: string) => Promise<ArchivedTabSession[]>

  sendMessage: (payload: SendMessagePayload) => Promise<void>
  stopGeneration: (tabId: string) => Promise<void>

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

  getAppVersion: () => Promise<string>
  isUpdateSupported: () => Promise<boolean>
  checkForUpdates: () => Promise<void>
  installUpdate: () => Promise<void>

  onStreamEvent: (cb: (event: unknown) => void) => () => void
  onUpdateStatus: (cb: (event: UpdateStatusEvent) => void) => () => void
}
