import type {
  AgentMode,
  ApprovalDecision,
  AppSettings,
  ArchivedTabSession,
  AssistantMemoryPool,
  CostReport,
  IndexStatus,
  MemoryCompactionResult,
  ModelInfo,
  PendingDocument,
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
/** Mirrors PawprintManifest (agent/pawprints/types.ts) for the IPC/renderer boundary — kept as an
 *  independent local shape rather than importing across the shared/src-main layering boundary. */
export interface PawprintManifestSummary {
  id: string
  name: string
  description: string
  instanceModel: 'single' | 'per-item'
  createdAt: number
  updatedAt: number
  sourceVersion: number
  packages: { name: string; version: string; registrySha512: string; direct: boolean; approvedAt: number }[]
  approvedDomains: string[]
  themeOverride: Record<string, string>
}

/** Mirrors PawprintInstanceRecord (agent/pawprints/types.ts) for the IPC/renderer boundary. */
export interface PawprintInstanceRecordSummary {
  pawprintId: string
  instanceId: string
  label?: string
  bounds?: { x: number; y: number; width: number; height: number }
  alwaysOnTop: boolean
  openOnLaunch: boolean
  updatedAt: number
}

/** One row for the "My Pawprints" panel: a manifest plus its known instance records (bounds/
 *  alwaysOnTop/openOnLaunch) and which instance ids currently have a live window open. */
export interface PawprintListEntry {
  manifest: PawprintManifestSummary
  instances: PawprintInstanceRecordSummary[]
  openInstanceIds: string[]
}

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
  extractDocument: 'chat:extractDocument',

  resolveApproval: 'approval:resolve',
  resolveQuestion: 'question:resolve',

  skillsList: 'skills:list',
  skillRead: 'skills:read',
  skillWrite: 'skills:write',

  subagentsList: 'subagents:list',
  subagentWrite: 'subagents:write',

  plansList: 'plans:list',
  planRead: 'plans:read',
  planApprove: 'plans:approve',

  memoryRead: 'memory:read',
  memoryWrite: 'memory:write',
  memoryCompact: 'memory:compact',

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
  brandingResetAll: 'branding:resetAll',

  pawprintList: 'pawprint:list',
  pawprintOpen: 'pawprint:open',
  pawprintClose: 'pawprint:close',
  pawprintDelete: 'pawprint:delete',
  pawprintDeleteInstance: 'pawprint:deleteInstance',
  pawprintSetAlwaysOnTop: 'pawprint:setAlwaysOnTop',
  pawprintSetThemeOverride: 'pawprint:setThemeOverride',
  // Pushed to every main-app window whenever the Pawprints registry/manifest data actually
  // changes on disk, regardless of which code path caused it (My Pawprints panel buttons, an
  // in-app control inside a Pawprint's own window like requestNewInstance/deleteSelf, or
  // reopenAllOnLaunch() at startup) — lets an already-mounted PawprintsPanel re-fetch live
  // instead of only refreshing after its own button clicks.
  onPawprintListChanged: 'pawprint:onListChanged',

  // Renderer-facing channels used ONLY by preloadPawprint.ts's contextBridge, inside a
  // Pawprint's own sandboxed BrowserWindow — never invoked from the main app's own renderer,
  // so these are intentionally not part of KlennyApi below.
  pawprintRendererGetState: 'pawprint:getState',
  pawprintRendererSetState: 'pawprint:setState',
  pawprintRendererGetTheme: 'pawprint:getTheme',
  pawprintRendererCloseSelf: 'pawprint:closeSelf',
  pawprintRendererRequestNewInstance: 'pawprint:requestNewInstance',
  // Lets a Pawprint's own UI delete ITS OWN instance (e.g. a "delete this note" in-app button on
  // a per-item sticky-note Pawprint) — distinct from pawprintRendererCloseSelf, which only closes
  // the window without touching persisted state/registry data.
  pawprintRendererDeleteSelf: 'pawprint:deleteSelf',
  pawprintRendererThemeChanged: 'pawprint:themeChanged',
  pawprintRendererStateChangedExternally: 'pawprint:stateChangedExternally'
} as const

export interface SendMessagePayload {
  tabId: string
  text: string
  images?: string[] // data URLs
  documents?: PendingDocument[]
}

/** Request body for the extractDocument IPC channel — the raw file bytes are always
 *  base64-encoded over the wire since IPC structured-clone doesn't reliably preserve Buffer. */
export interface ExtractDocumentRequest {
  filename: string
  mimeType: string
  base64: string
}

export type ExtractDocumentResult = ({ ok: true } & PendingDocument) | { ok: false; error: string }

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
  /** Extracts a just-attached .md/.txt/.docx file into model-readable text at attach time (not
   *  send time), so the pending-attachment UI can show size/parse errors immediately instead of
   *  only failing once the user hits Send. */
  extractDocument: (request: ExtractDocumentRequest) => Promise<ExtractDocumentResult>

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
  /** Approves a saved plan into `tabId`: switches it to Agent mode, sets up its live progress
   *  checklist, and kicks off the implementation turn. Fire-and-forget from the renderer's
   *  perspective — the resulting mode switch / checklist message / turn streaming all arrive via
   *  the usual `agent:stream` events (tab_upserted, message_start, etc.), same as sendMessage. */
  approvePlan: (slug: string, tabId: string) => Promise<void>

  readMemory: (scope: 'project' | 'global') => Promise<string>
  writeMemory: (scope: 'project' | 'global', content: string) => Promise<void>
  /** Runs the multi-pass "Compact memory" pipeline (see agent/memory/compaction.ts) for the given
   *  scope's auto-memory notes, using the utility model. Rewrites/prunes notes on disk in place;
   *  returns a before/after summary. Throws (leaving disk untouched) if any pass fails. */
  compactMemory: (scope: 'project' | 'global') => Promise<MemoryCompactionResult>

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

  /** "My Pawprints" panel data — every known Pawprint with its instance records and which are
   *  currently open. */
  listPawprints: () => Promise<PawprintListEntry[]>
  /** Opens (or focuses, if already open) a Pawprint instance. Omit instanceId to open a fresh
   *  instance (used for 'single'-model Pawprints and new 'per-item' instances alike). */
  openPawprint: (pawprintId: string, instanceId?: string) => Promise<{ instanceId: string }>
  closePawprint: (instanceId: string) => Promise<void>
  deletePawprint: (pawprintId: string) => Promise<void>
  /** Permanently deletes ONE instance (closes its window if open, removes its state file and
   *  registry record) without touching the Pawprint's shared manifest/source/packages — use
   *  deletePawprint() to remove the whole Pawprint instead. Safe to call down to zero remaining
   *  instances for either instance model; the panel falls back to a synthetic "reopen" row. */
  deletePawprintInstance: (pawprintId: string, instanceId: string) => Promise<void>
  setPawprintAlwaysOnTop: (instanceId: string, value: boolean) => Promise<void>
  setPawprintThemeOverride: (pawprintId: string, override: Record<string, string>) => Promise<void>
  /** Fires whenever the Pawprints registry/manifest data changes on disk from ANY source (not
   *  just this window's own panel actions) — see onPawprintListChanged's comment above. */
  onPawprintListChanged: (cb: () => void) => () => void
}
