// Shared types between the Electron main process and the renderer.
// Keep this file dependency-free so it can be imported from both worlds.

export type AgentMode = 'agent' | 'plan'

export type ApprovalMode = 'manual' | 'auto'

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
  /** effort levels this model actually accepts (from OpenRouter's `reasoning.supported_efforts`); undefined = model doesn't expose granular effort control (route via on/off only) */
  supportedReasoningEfforts?: string[]
  /** true if the model requires reasoning to always be on (we never send effort:'none' anyway, so this is informational only) */
  reasoningMandatory?: boolean
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
  /**
   * Set once a later tool call on the same resource (same file path / grep query / URL)
   * makes this result stale. `result` above is left completely untouched — this is an
   * additive annotation only. When present (and the collapsing setting is enabled), this
   * stub is sent to the model instead of the full `result` on every subsequent turn; the
   * UI still renders the full original `result` and shows a "summarized" badge alongside it.
   */
  supersededSummary?: string
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

// ---------- Tools ----------

export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'delete_file'
  | 'grep'
  | 'glob'
  | 'run_command'
  | 'web_search'
  | 'fetch_url'
  | 'list_skills'
  | 'read_skill'
  | 'read_memory'
  | 'write_memory'
  | 'task'
  | 'ask_question'
  | 'save_plan'

export interface ToolResultPayload {
  ok: boolean
  summary: string
  /** rich data used by the UI to render a specialized card (diff, grep hits, command output, ...) */
  data?: unknown
  error?: string
}

export const READ_ONLY_TOOLS: ToolName[] = [
  'read_file',
  'grep',
  'glob',
  'web_search',
  'fetch_url',
  'list_skills',
  'read_skill',
  'read_memory',
  'ask_question'
]

export const MUTATING_TOOLS: ToolName[] = ['write_file', 'edit_file', 'delete_file', 'run_command', 'write_memory', 'task']

// ---------- Approvals ----------

export type PendingActionKind = 'write_file' | 'edit_file' | 'delete_file' | 'run_command'

export interface PendingAction {
  id: string
  tabId: string
  kind: PendingActionKind
  toolCallId: string
  title: string
  /** unified diff text, present for write/edit/delete */
  diff?: string
  filePath?: string
  command?: string
  cwd?: string
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
}

export interface SubagentRun {
  id: string
  parentTabId: string
  agentType: string
  description: string
  status: 'running' | 'success' | 'error'
  summary?: string
  startedAt: number
  finishedAt?: number
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
  /** set while compaction has replaced earlier history */
  compactedThroughMessageId?: string
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
  /** when a re-read/re-edit of the same file (or repeat search/fetch) makes an older tool result stale, send a short stub instead of the full result on later turns to save tokens. Original result is always kept in history. */
  collapseSupersededResultsEnabled: boolean
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
  | { type: 'tool_call_result'; tabId: string; messageId: string; toolCallId: string; result: ToolResultPayload; status: ToolCallBlock['status'] }
  | { type: 'tool_call_superseded'; tabId: string; messageId: string; toolCallId: string; supersededSummary: string }
  | { type: 'user_message'; tabId: string; message: ChatMessage }
  | { type: 'message_start'; tabId: string; message: ChatMessage }
  | { type: 'message_end'; tabId: string; messageId: string; usage?: UsageInfo }
  | { type: 'turn_end'; tabId: string }
  | { type: 'error'; tabId: string; message: string }
  | { type: 'pending_action'; tabId: string; action: PendingAction }
  | { type: 'pending_action_resolved'; tabId: string; actionId: string }
  | { type: 'pending_question'; tabId: string; question: PendingQuestion }
  | { type: 'pending_question_resolved'; tabId: string; questionId: string }
  | { type: 'subagent_update'; tabId: string; run: SubagentRun }
  | { type: 'compaction'; tabId: string; summaryMessageId: string }
  | { type: 'spend_update'; tabId: string; totalCostUsd: number; totalSavingsUsd: number; capUsd: number | null }
  | { type: 'spend_blocked'; tabId: string }

export const CURATED_MODEL_IDS = [
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.5',
  'google/gemini-3-pro'
]

export const DEFAULT_MAIN_MODEL = 'anthropic/claude-sonnet-5'
export const DEFAULT_SUBAGENT_MODEL = 'anthropic/claude-sonnet-5'
/** Cheap/fast model for internal housekeeping (compaction summaries, etc.) — verified live on OpenRouter at plan time. */
export const DEFAULT_UTILITY_MODEL = 'anthropic/claude-haiku-4.5'

// ---------- Auto-update ----------

export type UpdateStatus = 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateStatusEvent {
  status: UpdateStatus
  version?: string
  percent?: number
  message?: string
}
