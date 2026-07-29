// Shared types between the Electron main process and the renderer.
// Keep this file dependency-free so it can be imported from both worlds.

export type AgentMode = 'agent' | 'plan'

/** 'manual': every mutating tool call (file edits and shell commands) waits for user approval.
 *  'auto': every mutating tool call is applied immediately, with a checkpoint commit for
 *  potential revert. 'command': file edits (write_file/edit_file/multi_edit/delete_file) are
 *  auto-applied like 'auto', but run_command calls still require manual approval — a middle
 *  ground for users who trust the agent's code changes but want to review shell commands. */
export type ApprovalMode = 'manual' | 'auto' | 'command'

/** Per-tab approval mode override, selectable from the dropdown next to Send/Stop. 'default'
 *  means "use whatever AppSettings.approvalMode currently is" — the only value that's not one
 *  of the three concrete ApprovalMode values. */
export type TabApprovalMode = ApprovalMode | 'default'

export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface ModelInfo {
  id: string
  name: string
  contextLength: number
  promptPrice: number // USD per token
  completionPrice: number // USD per token
  /** USD per token to read a cached prompt token; null = provider/model doesn't support caching */
  cacheReadPrice: number | null
  /** USD per token to write a new cache entry; null = no explicit write pricing (implicit-only or free writes) */
  cacheWritePrice: number | null
  /** true for model families (Anthropic, Qwen, Alibaba-hosted DeepSeek v3.2) that require us to inject cache_control markers ourselves */
  supportsExplicitCaching: boolean
  supportsTools: boolean
  supportsReasoning: boolean
  supportsVision: boolean
  /** true if this model's only output modality is embeddings (i.e. it's an embeddings model, not a chat model) */
  supportsEmbeddings: boolean
  /** effort levels this model actually accepts (from OpenRouter's `reasoning.supported_efforts`); undefined = model doesn't expose granular effort control (route via on/off only) */
  supportedReasoningEfforts?: string[]
  /** true if the model requires reasoning to always be on (we never send effort:'none' anyway, so this is informational only) */
  reasoningMandatory?: boolean
  /** provider-reported max output tokens for this model (OpenRouter `top_provider.max_completion_tokens`); undefined if not reported, in which case callers fall back to a conservative default */
  maxCompletionTokens?: number
  pinned?: boolean
}

// ---------- Message content blocks ----------

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  text: string
}

export interface ImageBlock {
  type: 'image'
  /** data URL, e.g. data:image/png;base64,... */
  dataUrl: string
}

export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  toolName: string
  args: Record<string, unknown>
  /** populated once the tool finishes */
  status: 'running' | 'success' | 'error' | 'awaiting_approval' | 'rejected'
  result?: ToolResultPayload
  /** Short human-readable label for a long-running step within a still-`running` tool call
   *  (e.g. "Downloading Chromium (42 MB)…" for the browser tool's one-time first-run install).
   *  Cleared implicitly once `result`/a terminal `status` is set. Purely cosmetic. */
  progressMessage?: string
}

export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | ToolCallBlock

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  blocks: ContentBlock[]
  createdAt: number
  /** OpenRouter usage for this specific assistant turn, if applicable */
  usage?: UsageInfo
  /** marks a synthetic message inserted by context-compaction */
  isCompactionSummary?: boolean
  /** reasoning effort level automatically chosen for this assistant turn, if the model supports reasoning */
  reasoningEffort?: ReasoningEffort
}

// ---------- Usage / cost accounting ----------

export interface UsageInfo {
  promptTokens: number
  completionTokens: number
  /** tokens read from a prompt cache (usage.prompt_tokens_details.cached_tokens) */
  cachedTokens: number
  /** tokens written to a prompt cache (usage.prompt_tokens_details.cache_write_tokens) */
  cacheWriteTokens: number
  /** actual amount charged, already net of any cache discount */
  costUsd: number
  /** what this turn would have cost with no caching at all, for savings display */
  costWithoutCacheUsd: number
  /** costWithoutCacheUsd - costUsd; can be negative on a pure cache-write turn */
  cacheSavingsUsd: number
}

export interface CostReportRow {
  /** model id, or 'all' for the aggregated total row */
  model: string
  costUsd: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  uncachedTokens: number
}

export interface CostReport {
  /** current project path, or null if none is open */
  currentProject: string | null
  /** per-model rows plus an aggregated 'all' row, scoped to the current project */
  currentProjectRows: CostReportRow[]
  /** per-model rows plus an aggregated 'all' row, across every project ever recorded */
  allProjectsRows: CostReportRow[]
}

// ---------- Tools ----------

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'multi_edit'
  | 'delete_file'
  | 'read_docx'
  | 'write_docx'
  | 'edit_docx'
  | 'read_image'
  | 'grep'
  | 'glob'
  | 'run_command'
  | 'read_terminal'
  | 'web_search'
  | 'fetch_url'
  | 'list_skills'
  | 'read_skill'
  | 'read_memory'
  | 'write_memory'
  | 'list_memory'
  | 'write_skill'
  | 'write_subagent'
  | 'read_subagent'
  | 'task'
  | 'ask_question'
  | 'save_plan'
  | 'codebase_search'
  | 'list_projects'
  | 'open_settings_panel'
  | 'gmail_list_messages'
  | 'gmail_get_message'
  | 'gmail_send_message'
  | 'discord_post_message'
  | 'scheduler_create_task'
  | 'scheduler_list_tasks'
  | 'scheduler_update_task'
  | 'scheduler_delete_task'
  | 'browser'

/** Tools that need a real, open coding-project *workspace* to make sense — a shell to run
 *  commands in, or a semantic index built over a specific project — and so remain gated off
 *  entirely on Assistant-kind tabs (they have no workspace) and on any project tab with no
 *  workspace open. See getToolDefinitions() in agent/tools/definitions.ts.
 *
 *  File tools (read_file/write_file/edit_file/multi_edit/delete_file/grep/glob) are
 *  deliberately NOT in this list even though they used to be: Assistant tabs now get them too,
 *  scoped to AppSettings.documentsDirectory (default: the OS Documents folder) for anything
 *  that resolves a relative path or performs a mutation — see file-ops.ts's resolveWorkspacePath
 *  `root` parameter and documentsDir.ts. Reads given an absolute path can still reach anywhere
 *  on the host, same as in a project tab; only the *root* differs (documentsDirectory instead of
 *  the open project) and mutations are sandboxed under that root instead of the workspace. */
export const CODING_ONLY_TOOLS: ToolName[] = ['run_command', 'read_terminal', 'codebase_search']

/** The single multiplexed browser-automation tool (action-addressed: open/navigate/snapshot/
 *  click/etc — see agent/tools/browser.ts). Doesn't fit CODING_ONLY_TOOLS (no file/workspace
 *  I/O) or ASSISTANT_TOOLS (needs per-tab session/process state, unlike stateless tools such as
 *  web_search) — gets its own bucket. Agent-mode only (see getToolDefinitions()); available in
 *  both project and Assistant-tab contexts since browsing doesn't require a workspace.
 *  Deliberately never gated by AppSettings.*AvailableInCoding — browser automation stays fully
 *  available on project tabs in both Plan and Agent mode, unlike docx/Gmail/Discord below. */
export const BROWSER_TOOLS: ToolName[] = ['browser']

/** Word .docx tools. Always available on an Assistant tab (part of ASSISTANT_TOOLS below). On a
 *  project-kind tab they're additionally gated on AppSettings.docxAvailableInCoding (default
 *  false) — see getToolDefinitions()'s docx gate — since most coding projects have no use for
 *  Word documents and the model shouldn't be offered a tool most users never want there. */
export const DOCX_TOOLS: ToolName[] = ['read_docx', 'write_docx', 'edit_docx']

/** Gmail tools. Gated everywhere (Assistant tabs included) on being connected
 *  (AppSettings.hasGmailToken) and on the relevant AutomationPermissions entry
 *  ('gmail.read' for list/get, 'gmail.send' for send) — a tool that's guaranteed to fail should
 *  never be offered to the model. On a project-kind tab they're additionally gated on
 *  AppSettings.gmailAvailableInCoding (default false) — see getToolDefinitions()'s gmail gate. */
export const GMAIL_READ_TOOLS: ToolName[] = ['gmail_list_messages', 'gmail_get_message']
export const GMAIL_SEND_TOOLS: ToolName[] = ['gmail_send_message']
export const GMAIL_TOOLS: ToolName[] = [...GMAIL_READ_TOOLS, ...GMAIL_SEND_TOOLS]

/** Discord tools. Gated everywhere (Assistant tabs included) on being connected
 *  (AppSettings.hasDiscordToken) and on the 'discord.post' AutomationPermissions entry. On a
 *  project-kind tab they're additionally gated on AppSettings.discordAvailableInCoding (default
 *  false) — see getToolDefinitions()'s discord gate. */
export const DISCORD_TOOLS: ToolName[] = ['discord_post_message']

/** Canonical, authoritative list of every tool available on an Assistant-kind tab (kind ===
 *  'assistant') — consumed directly by getToolDefinitions() to build its `assistantAllowed` set
 *  (agent/src/main/agent/tools/definitions.ts). ASSISTANT_MODE_PROMPT_BODY in plan/manager.ts
 *  separately spells the same tool names out in its capabilities paragraph in prose (not
 *  generated from this array) — keep the two in sync by hand whenever this list changes. Also
 *  enforced server-side as an allowlist at dispatch time (see the Assistant-tab guard in
 *  orchestrator/loop.ts's executeTool()).
 *
 *  Includes the file tools (scoped to AppSettings.documentsDirectory for relative paths and all
 *  mutations — see CODING_ONLY_TOOLS's doc comment above) alongside everything genuinely
 *  workspace-independent. Deliberately excludes run_command/read_terminal/codebase_search
 *  (CODING_ONLY_TOOLS — need a real project workspace) and save_plan (plan mode is hidden from
 *  Assistant tabs entirely; see the mode-toggle visibility fix). */
export const ASSISTANT_TOOLS: ToolName[] = [
  'read_file',
  'write_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'read_docx',
  'write_docx',
  'edit_docx',
  'read_image',
  'grep',
  'glob',
  'web_search',
  'fetch_url',
  'list_projects',
  'list_skills',
  'read_skill',
  'read_memory',
  'write_memory',
  'list_memory',
  'write_skill',
  'write_subagent',
  'read_subagent',
  'task',
  'ask_question',
  'open_settings_panel',
  'gmail_list_messages',
  'gmail_get_message',
  'gmail_send_message',
  'discord_post_message',
  'scheduler_create_task',
  'scheduler_list_tasks',
  'scheduler_update_task',
  'scheduler_delete_task',
  'browser'
]

export interface ToolResultPayload {
  ok: boolean
  summary: string
  /** rich data used by the UI to render a specialized card (diff, grep hits, command output, ...) */
  data?: unknown
  error?: string
}

export const READ_ONLY_TOOLS: ToolName[] = [
  'read_file',
  'read_docx',
  'read_image',
  'grep',
  'glob',
  'read_terminal',
  'web_search',
  'fetch_url',
  'list_skills',
  'read_skill',
  'read_memory',
  'list_memory',
  'read_subagent',
  'ask_question',
  'codebase_search',
  'list_projects'
]

export const MUTATING_TOOLS: ToolName[] = [
  'write_file',
  'edit_file',
  'multi_edit',
  'delete_file',
  'write_docx',
  'edit_docx',
  'run_command',
  'write_memory',
  'write_skill',
  'write_subagent',
  'task',
  'browser'
]

// ---------- Approvals ----------

export type PendingActionKind =
  | 'write_file'
  | 'edit_file'
  | 'multi_edit'
  | 'delete_file'
  | 'write_docx'
  | 'edit_docx'
  | 'run_command'
  | 'browser_act'

export interface PendingAction {
  id: string
  tabId: string
  kind: PendingActionKind
  toolCallId: string
  title: string
  /** unified diff text, present for write/edit/delete — for multi_edit this is the
   *  concatenation of every affected file's diff, in the same unified-diff format git
   *  uses for multi-file patches, so DiffViewer renders it exactly like a single diff. */
  diff?: string
  filePath?: string
  /** populated instead of filePath for multi_edit — every file the batch touches. */
  filePaths?: string[]
  command?: string
  cwd?: string
  /** browser_act only: base64 data URL of a lightweight screenshot thumbnail captured while
   *  building the preview, if one was taken — never captured on every 'auto'-policy call, only
   *  when actually building an approval preview for 'ask' policy. */
  screenshotDataUrl?: string
  createdAt: number
}

export type ApprovalDecision = 'accept' | 'reject' | 'accept_all'

// ---------- Ask-question tool ----------

export interface QuestionOption {
  id: string
  label: string
}

export interface QuestionSpec {
  id: string
  prompt: string
  options: QuestionOption[]
  allowMultiple?: boolean
}

export interface PendingQuestion {
  id: string
  tabId: string
  toolCallId: string
  questions: QuestionSpec[]
  createdAt: number
}

export interface QuestionAnswer {
  questionId: string
  optionIds: string[]
  otherText?: string
}

// ---------- Skills & Subagents ----------

export interface SkillSummary {
  name: string
  description: string
  scope: 'project' | 'global'
  path: string
}

export interface SubagentTypeSummary {
  name: string
  description: string
  tools: ToolName[] | 'all'
  model?: string
  builtIn: boolean
  scope?: 'project' | 'global'
  path?: string
  /** Custom subagent types' full SKILL.md-style instructions (the markdown body below the
   *  frontmatter), fed into that subagent run's system prompt. Undefined for built-in types,
   *  which get their behavior from the generic agent-mode prompt plus their tool restriction. */
  body?: string
}

export interface SubagentRun {
  id: string
  parentTabId: string
  agentType: string
  description: string
  status: 'running' | 'success' | 'error'
  /** Short human-readable label for what the subagent is doing right now, e.g. "Reading agent/src/foo.ts" or "Thinking...". Only meaningful while status === 'running'. */
  activity?: string
  summary?: string
  startedAt: number
  finishedAt?: number
  /** Client-side only: user dismissed this run's card from the Subagents panel after it finished. */
  hidden?: boolean
  /** Cumulative USD cost of this subagent's own turns, updated live while it runs (mirrors
   *  TabSession.totalCostUsd for the subagent's own ephemeral sub-tab). */
  totalCostUsd: number
  /** Cumulative USD saved via prompt caching on this subagent's own turns (mirrors
   *  TabSession.totalSavingsUsd). */
  totalSavingsUsd: number
}

// ---------- Plan mode ----------

export interface PlanArtifact {
  slug: string
  title: string
  markdown: string
  path: string
  createdAt: number
}

// ---------- Sessions / Tabs ----------

export interface TabSession {
  id: string
  title: string
  mode: AgentMode
  model: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
  totalCostUsd: number
  /** cumulative USD saved via prompt caching this session (display only, not used for spend caps) */
  totalSavingsUsd?: number
  /** id of the last message in `messages` that has been folded into `compactionSummary`.
   *  Compaction never removes or rewrites anything in `messages` (that stays the full,
   *  authentic history shown in the UI) — instead this + `compactionSummary` are consulted
   *  only when building the wire-format request to the model, replacing every message up to
   *  and including this id with the summary text. */
  compactedThroughMessageId?: string
  /** rolling summary text covering all messages up to and including `compactedThroughMessageId`.
   *  Sent to the model as a system message in place of the real (older) messages. */
  compactionSummary?: string
  /** 'project' (default, omitted on old persisted tabs): a normal workspace-scoped coding tab.
   *  'assistant': a tab opened via the sidebar "Open Assistant" button — has no workspace, only
   *  assistant tools (Gmail/Discord/scheduler/web/cross-project/memory). Workspace-independent:
   *  persisted to its own fixed file rather than any per-workspace session file, so it survives
   *  an app restart and a workspace switch alike; when closed (with messages) it's archived to
   *  the separate "Assistant" section of the History panel rather than the per-workspace one.
   *  See the Personal Assistant Platform plan for the original v1 scope decision, and the
   *  Assistant tab persistence/history follow-up for this behavior. */
  kind?: 'project' | 'assistant'
  /** Per-tab override for approval mode, shown in the dropdown next to Send/Stop. undefined
   *  (or 'default' on older persisted tabs) means "use AppSettings.approvalMode". Clicking
   *  "Accept all" on a pending action sets this to 'auto' for that tab. */
  approvalMode?: TabApprovalMode
}

/** A tab that was closed and archived for later browsing/reopening in the History panel. */
export interface ArchivedTabSession extends TabSession {
  closedAt: number
}

// ---------- Settings ----------

export interface ProviderPreference {
  /** restrict routing to only these provider slugs (still allows fallback among them, keeps sticky routing) */
  only?: string[]
  /** explicit provider try-order (disables OpenRouter's sticky routing / load balancing — use sparingly) */
  order?: string[]
}

export interface AppSettings {
  hasApiKey: boolean
  mainModel: string
  subagentModel: string
  /** cheap/fast model used for internal housekeeping calls (e.g. compaction summaries) — quality here doesn't affect main answers */
  utilityModel: string
  approvalMode: ApprovalMode
  theme: 'dark' | 'light'
  spendingCapUsd: number | null
  spendingCapPeriod: 'session' | 'daily'
  autoMemoryEnabled: boolean
  /** global kill switch for OpenRouter prompt caching (session_id + cache_control injection) */
  promptCachingEnabled: boolean
  /** optional advanced provider pinning, e.g. to force a single BYOK provider */
  providerPreference?: ProviderPreference
  lastWorkspace?: string | null
  /** id of the shell used for run_command (e.g. 'cmd', 'powershell', 'git-bash', 'bash', 'zsh'); null = auto-pick OS default */
  shellId?: string | null
  /** master on/off switch for the semantic codebase search index — off by default (opt-in, since it spends OpenRouter credits on embeddings and runs a background file watcher) */
  codebaseIndexEnabled: boolean
  /** OpenRouter model id used to embed code chunks/queries; null until the user enables the feature and picks one */
  embeddingsModel: string | null
  /** where embedded vectors are stored/queried; 'local' needs no signup, 'pinecone' requires a separate Pinecone API key below */
  vectorStoreBackend: 'local' | 'pinecone'
  /** required when vectorStoreBackend === 'pinecone' */
  pineconeIndexName: string | null
  /** boolean flag only — actual secret is encrypted separately and never round-trips to the renderer, same pattern as hasApiKey */
  hasPineconeKey: boolean
  /** 'auto' (default): the agent keeps working through long tasks on its own up to a generous hard safety ceiling.
   *  'checkpoint': the agent pauses every `turnCheckpointSteps` tool-round-trips and waits for the user to click Continue. */
  continueMode: 'auto' | 'checkpoint'
  /** only used when continueMode === 'checkpoint' — how many tool-round-trips to run before pausing */
  turnCheckpointSteps: number

  // ---------- Personal Assistant Platform (Gmail / Discord / Scheduler) ----------

  /** boolean flag only — actual OAuth tokens are encrypted separately and never round-trip to the renderer */
  hasGmailToken: boolean
  gmailAccountEmail: string | null
  /** user's own Google Cloud OAuth client — not a secret on its own, but only meaningful alongside the encrypted refresh token, so stored in settings.json rather than as a *.enc file */
  gmailClientId: string | null
  gmailClientSecret: string | null
  /** set when a token refresh fails (revoked/expired); cleared on next successful connect */
  lastGmailRefreshError: string | null
  /** Off by default (opt-in). Whether the Gmail tools (gmail_list_messages/gmail_get_message/
   *  gmail_send_message — see GMAIL_TOOLS) are offered on regular project (coding) tabs at all,
   *  in both Plan and Agent mode. Always additionally gated on hasGmailToken and the relevant
   *  automationPermissions entry regardless of this flag; this flag only controls whether a
   *  connected+permitted tool is also surfaced outside the Assistant tab, which always gets it
   *  (subject to the same connection/permission gate). See getToolDefinitions(). */
  gmailAvailableInCoding: boolean

  /** boolean flag only — actual bot token is encrypted separately and never round-trips to the renderer */
  hasDiscordToken: boolean
  /** cached for display once connected, e.g. "Klenny#1234" */
  discordBotTag: string | null
  lastDiscordConnectionError: string | null
  /** Off by default (opt-in). Whether discord_post_message (see DISCORD_TOOLS) is offered on
   *  regular project (coding) tabs at all, in both Plan and Agent mode. Always additionally
   *  gated on hasDiscordToken and automationPermissions['discord.post'] regardless of this flag.
   *  See getToolDefinitions(). */
  discordAvailableInCoding: boolean

  /** Off by default (opt-in). Whether the Word .docx tools (read_docx/write_docx/edit_docx —
   *  see DOCX_TOOLS) are offered on regular project (coding) tabs at all, in both Plan and Agent
   *  mode. Always available on the Assistant tab regardless of this flag (see ASSISTANT_TOOLS).
   *  See getToolDefinitions(). */
  docxAvailableInCoding: boolean

  automationPermissions: AutomationPermissions

  /** Off by default (opt-in) — see BrowserAutomationSettings/DEFAULT_BROWSER_AUTOMATION above. */
  browserAutomation: BrowserAutomationSettings

  /** master toggle for the background scheduler tick loop */
  schedulerEnabled: boolean
  /** minimize-to-tray instead of quitting on window close */
  minimizeToTray: boolean
  /** start Klenny Code automatically on OS login (wired via app.setLoginItemSettings) */
  startOnLogin: boolean

  // ---------- Appearance / branding ----------

  /** custom display name shown in the sidebar, header, and window title in place of "Klenny
   *  Code" — max BRAND_NAME_MAX_LENGTH characters. null/empty = use the default. */
  brandName: string | null
  /** boolean flag only — the actual image bytes live on disk under the app's userData
   *  directory (see agent/src/main/branding.ts), never round-tripped through settings.json,
   *  mirroring the hasApiKey-style pattern used for secrets. */
  hasCustomIcon: boolean
  /** boolean flag only — see hasCustomIcon */
  hasCustomRunningGif: boolean

  /** Aggregate token budget for the Assistant-window shared memory pool (see
   *  AssistantMemoryPool). 'disabled' turns off all silent background writes immediately. */
  assistantMemorySize: AssistantMemorySize

  /** Root directory that Assistant-tab file tools (read_file/write_file/edit_file/multi_edit/
   *  delete_file/grep/glob) resolve relative paths against and sandbox all mutations under —
   *  Assistant tabs have no project workspace, so this stands in for one. null = use the OS
   *  default Documents folder (see documentsDir.ts's defaultDocumentsDirectory()); set via
   *  Settings -> General to pick a different folder. Absolute-path reads (read_file/grep/glob)
   *  still reach anywhere on the host regardless of this setting, exactly like in a project tab
   *  — only relative-path resolution and every mutation are confined to this directory. */
  documentsDirectory: string | null
}

/** Max length enforced for AppSettings.brandName, both in the renderer input and defensively
 *  in the main-process settings save path. */
export const BRAND_NAME_MAX_LENGTH = 15

// ---------- Assistant window shared, auto-compacting memory ----------

/** Aggregate token budget for the whole Assistant-memory pool. 'disabled' stops all silent
 *  writes immediately (existing slots/rollup stay on disk, simply excluded from prompts). */
export type AssistantMemorySize = 10000 | 20000 | 'disabled'

export const DEFAULT_ASSISTANT_MEMORY_SIZE: AssistantMemorySize = 10000

/** One Assistant window's continuously-updated memory slot, silently rewritten in place by the
 *  app after each round of work — never via a model-visible tool call. Persists after its tab
 *  is closed/deleted; only compaction or explicit user deletion ever removes content. */
export interface AssistantMemorySlot {
  tabId: string
  /** snapshot of the tab's title at last update time, for display after the tab is gone */
  tabTitle: string
  content: string
  updatedAt: number
  tokenEstimate: number
  /** id of the last tab.messages entry folded into `content` so far; null = never memorized yet */
  lastMemorizedMessageId: string | null
}

/** Single rolled-up note that older, compacted-away slot content gets merged into once the
 *  pool's aggregate budget is exceeded. */
export interface AssistantMemoryRollup {
  content: string
  updatedAt: number
  tokenEstimate: number
}

export interface AssistantMemoryPool {
  slots: AssistantMemorySlot[]
  rollup: AssistantMemoryRollup | null
}

export const DEFAULT_BRAND_NAME = 'Klenny Code'

/** Per-action-category automation policy. 'auto' = allowed to run unattended (subagent/scheduled
 *  contexts) and, in live chat tabs, still subject to the existing ApprovalManager gate when
 *  approvalMode is 'manual'. 'off' = the action is blocked outright, in every context, with a
 *  clear error returned to the caller. There is deliberately no third 'ask' state in v1 — see
 *  the Personal Assistant Platform plan's Risks section for why a live approval queue for
 *  unattended actions is out of scope for now. */
export type AutomationPolicyValue = 'auto' | 'off'

export interface AutomationPermissions {
  'gmail.read': AutomationPolicyValue
  'gmail.send': AutomationPolicyValue
  'discord.read': AutomationPolicyValue
  'discord.post': AutomationPolicyValue
  'scheduler.run': AutomationPolicyValue
}

export const DEFAULT_AUTOMATION_PERMISSIONS: AutomationPermissions = {
  'gmail.read': 'auto',
  'gmail.send': 'off',
  'discord.read': 'auto',
  'discord.post': 'off',
  'scheduler.run': 'auto'
}

// ---------- Browser automation ----------

/** Separate from AutomationPolicyValue/AutomationPermissions above (which is a flat
 *  'auto'|'off' map shared by gmail/discord/scheduler) because the user explicitly wants a
 *  third "ask" state for browser mutation — a live approval queue, not just an unattended-run
 *  allow/block toggle. 'off': the browser tool's mutating actions always fail. 'ask': mutating
 *  actions queue via ApprovalManager same as write_file/run_command (subject to the same
 *  per-tab approvalMode/acceptAll rules). 'auto': mutating actions execute immediately. Applies
 *  only to *mutating* browser actions — open/close/list_tabs/navigate/snapshot/screenshot are
 *  always allowed once the policy isn't 'off' (see the browser tool's dispatch handler). */
export type BrowserAutomationPolicy = 'off' | 'ask' | 'auto'

export interface BrowserAutomationSettings {
  policy: BrowserAutomationPolicy
  /** Subagent- and scheduled-task-owned sessions are always headless regardless of this flag —
   *  it only controls whether *this* toggle is surfaced as already-safe-by-default in the UI.
   *  Kept as an explicit setting (rather than hardcoding "always headless for unattended") so a
   *  future version could offer an opt-out for debugging, but v1 always forces true internally
   *  for subagent/scheduled runs regardless of what this is set to. */
  headlessForUnattendedRuns: boolean
  /** Interactive (chat-tab-owned) sessions only. */
  allowPrivateNetwork: boolean
  /** Subagent- and scheduler-owned sessions — deliberately a separate, stricter-by-default flag
   *  so enabling private-network access for interactive use doesn't silently also open it up
   *  for unattended runs, which are the highest-risk surface for SSRF/LAN-scanning via a
   *  compromised or prompt-injected page. */
  allowPrivateNetworkUnattended: boolean
  /** Arbitrary JS execution (the 'evaluate' action) — independent of `policy`, off by default,
   *  and never available to subagents regardless of this setting (enforced in the tool handler
   *  as defense in depth, not just by omission from allowlists). */
  allowEvaluate: boolean
  /** Optional: reuse an installed Chrome/Edge/Brave instead of Playwright's bundled Chromium.
   *  If unset (the default), Playwright's Chromium is used — since the npm package doesn't ship
   *  browser binaries, the very first browser session in the app's lifetime downloads it lazily
   *  (one-time, ~150 MB; see src/main/browser/installer.ts), surfacing progress via
   *  `tool_call_progress`. If set, the path is passed straight to Playwright's launcher with no
   *  validation ahead of time — an invalid/missing path fails the launch with Playwright's own
   *  error rather than silently falling back. */
  browserExecutablePath: string | null
  /** App-wide cap on concurrent Playwright Browser processes; additional requests fail with a
   *  clear error rather than queuing (see BrowserSessionManager). */
  maxConcurrentSessions: number
}

export const DEFAULT_BROWSER_AUTOMATION: BrowserAutomationSettings = {
  policy: 'off',
  headlessForUnattendedRuns: true,
  allowPrivateNetwork: true,
  allowPrivateNetworkUnattended: false,
  allowEvaluate: false,
  browserExecutablePath: null,
  maxConcurrentSessions: 3
}

// ---------- Scheduler ----------

export type ScheduledTaskStatus = 'success' | 'error' | 'interrupted'

export interface ScheduledTask {
  id: string
  name: string
  /** natural-language instruction run as a subagent prompt each time the task fires */
  prompt: string
  /** standard 5-field cron expression, evaluated in the user's local time */
  schedule: string
  /** absolute path of a known coding project to run the task against, or null for the
   *  workspace-less Assistant tool context (Gmail/Discord/web/cross-project/scheduler tools only) */
  targetWorkspace: string | null
  enabled: boolean
  /** optional per-run USD ceiling in addition to the existing global spending cap / step budget */
  maxCostUsd: number | null
  /** optional cap on total number of firings before the task deletes itself automatically.
   *  null/undefined means "run indefinitely on schedule" (the pre-existing behavior). A one-shot
   *  task ("do this at 8pm", "remind me in 10 minutes") should be created with a cron expression
   *  matching that single moment and maxRuns: 1, rather than left to fire forever. */
  maxRuns: number | null
  /** how many times this task has fired so far (including the current/most recent run).
   *  Compared against maxRuns to decide whether to self-delete after each run. */
  runCount: number
  createdAt: number
  lastRunAt: number | null
  lastExitStatus: ScheduledTaskStatus | null
  /** short preview of the run's final summary, for display in the Scheduled Tasks panel */
  lastOutputPreview: string | null
  nextRunAt: number | null
  /** id of the tab that was active when this task was created via the scheduler_create_task
   *  tool, so a completed run can be reported back to that same tab. Null for tasks created
   *  without a live tab context (should not normally happen, but kept optional/nullable for
   *  forward/backward compatibility with tasks persisted before this field existed). */
  creatorTabId?: string | null
  /** 'project' | 'assistant' kind of the creator tab at creation time — determines what kind of
   *  tab gets opened as a fallback if the creator tab can no longer be found (closed and not in
   *  history, or history entry deleted). Falls back to inferring from targetWorkspace when
   *  absent (older persisted tasks). */
  creatorTabKind?: 'project' | 'assistant' | null
  /** absolute path of the workspace that was active (if any) when this task was created —
   *  used to know which workspace's session/history file to look in for the creator tab when
   *  the task fires and that workspace isn't the currently-open one. Null for tasks created
   *  from an Assistant tab (no workspace) or before this field existed. */
  creatorWorkspace?: string | null
}

// ---------- Shells ----------

export type ShellKind = 'cmd' | 'powershell' | 'posix' | 'wsl'

export interface ShellInfo {
  /** stable identifier stored in settings, e.g. 'cmd', 'powershell', 'pwsh', 'git-bash', 'wsl', 'bash', 'zsh', 'fish', 'sh' */
  id: string
  /** human-readable label for the settings UI */
  name: string
  /** absolute path to the shell executable on this machine */
  path: string
  /** determines how the command string is passed to this shell (flags, invocation style) */
  kind: ShellKind
}

// ---------- Streaming events (main -> renderer) ----------

export type AgentStreamEvent =
  | { type: 'text_delta'; tabId: string; messageId: string; delta: string }
  | { type: 'thinking_delta'; tabId: string; messageId: string; delta: string }
  | { type: 'tool_call_start'; tabId: string; messageId: string; block: ToolCallBlock }
  /** Cosmetic progress update for a still-running tool call (currently only emitted by the
   *  browser tool's one-time Chromium download). Never changes `status`. */
  | { type: 'tool_call_progress'; tabId: string; messageId: string; toolCallId: string; message: string }
  | { type: 'tool_call_result'; tabId: string; messageId: string; toolCallId: string; result: ToolResultPayload; status: ToolCallBlock['status'] }
  | { type: 'user_message'; tabId: string; message: ChatMessage }
  | { type: 'message_start'; tabId: string; message: ChatMessage }
  | { type: 'message_end'; tabId: string; messageId: string; usage?: UsageInfo }
  | { type: 'turn_end'; tabId: string }
  /** Turn stopped early without finishing the task — either the checkpoint step count was
   *  reached (continueMode === 'checkpoint') or the hard safety ceiling was hit (always
   *  enforced). `turn_end` is still emitted separately right after this to clear streaming UI
   *  state; this event is what drives the "paused, click Continue" banner. */
  | { type: 'turn_paused'; tabId: string; reason: 'checkpoint' | 'hard_limit'; stepsCompleted: number }
  | { type: 'error'; tabId: string; message: string }
  | { type: 'pending_action'; tabId: string; action: PendingAction }
  | { type: 'pending_action_resolved'; tabId: string; actionId: string }
  | { type: 'pending_question'; tabId: string; question: PendingQuestion }
  | { type: 'pending_question_resolved'; tabId: string; questionId: string }
  | { type: 'subagent_update'; tabId: string; run: SubagentRun }
  | { type: 'compaction'; tabId: string; compactedThroughMessageId: string; summary: string }
  | { type: 'spend_update'; tabId: string; totalCostUsd: number; totalSavingsUsd: number; capUsd: number | null }
  | { type: 'spend_blocked'; tabId: string }
  /** A tab was created, restored from history, or had a message appended to it outside of a
   *  normal user-driven turn (currently only used to deliver a finished scheduled task's result
   *  back into the tab that created it). Renderer should replace the tab if its id is already
   *  present in `tabs`, or append it as a new tab otherwise. Only ever emitted for tabs in the
   *  currently-open workspace (or workspace-less Assistant tabs) — never for a background
   *  workspace the user doesn't have open right now. */
  | { type: 'tab_upserted'; tab: TabSession }
  /** Companion to `tab_upserted` for the reopened-from-history case, so the History panel (if
   *  open) drops the entry it just got restored from. */
  | { type: 'history_entry_removed'; tabId: string }
  | {
      type: 'index_progress'
      phase: 'scanning' | 'embedding' | 'idle' | 'error'
      filesTotal?: number
      filesDone?: number
      message?: string
    }

export const CURATED_MODEL_IDS = [
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-5',
  'openai/gpt-5.5',
  'google/gemini-3-pro'
]

export const DEFAULT_MAIN_MODEL = 'anthropic/claude-sonnet-5'
export const DEFAULT_SUBAGENT_MODEL = 'anthropic/claude-sonnet-5'
/** Cheap/fast model for internal housekeeping (compaction summaries, etc.) — verified live on OpenRouter at plan time. */
export const DEFAULT_UTILITY_MODEL = 'anthropic/claude-haiku-4.5'
/** Best code-retrieval-tuned embedding model actually available on OpenRouter at plan time (Cohere has no embeddings there — checked directly). Cheap ($0.01/M tokens), 32K context. Verify this id still resolves before assuming it's current. */
export const DEFAULT_EMBEDDINGS_MODEL = 'qwen/qwen3-embedding-8b'

// ---------- Codebase semantic search ----------

export interface IndexStatus {
  enabled: boolean
  phase: 'idle' | 'scanning' | 'embedding' | 'error'
  filesTotal: number
  filesDone: number
  lastUpdatedAt: number | null
  message?: string
  backend: 'local' | 'pinecone'
  embeddingsModel: string | null
}

// ---------- Auto-update ----------

export type UpdateStatus = 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateStatusEvent {
  status: UpdateStatus
  version?: string
  percent?: number
  message?: string
}
