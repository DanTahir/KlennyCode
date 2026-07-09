// Shared types between the Electron main process and the renderer.
// Keep this file dependency-free so it can be imported from both worlds.

export type AgentMode = 'agent' | 'plan'

export type ApprovalMode = 'manual' | 'auto'

export interface ModelInfo {
  id: string
  name: string
  contextLength: number
  promptPrice: number // USD per token
  completionPrice: number // USD per token
  supportsTools: boolean
  supportsReasoning: boolean
  supportsVision: boolean
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
}

export type ContentBlock = TextBlock | ThinkingBlock | ImageBlock | ToolCallBlock

export interface ChatMessage {
  id: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  blocks: ContentBlock[]
  createdAt: number
  /** OpenRouter usage for this specific assistant turn, if applicable */
  usage?: { promptTokens: number; completionTokens: number; costUsd: number }
  /** marks a synthetic message inserted by context-compaction */
  isCompactionSummary?: boolean
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
  /** set while compaction has replaced earlier history */
  compactedThroughMessageId?: string
}

// ---------- Settings ----------

export interface AppSettings {
  hasApiKey: boolean
  mainModel: string
  subagentModel: string
  approvalMode: ApprovalMode
  theme: 'dark' | 'light'
  spendingCapUsd: number | null
  spendingCapPeriod: 'session' | 'daily'
  autoMemoryEnabled: boolean
  lastWorkspace?: string | null
}

// ---------- Streaming events (main -> renderer) ----------

export type AgentStreamEvent =
  | { type: 'text_delta'; tabId: string; messageId: string; delta: string }
  | { type: 'thinking_delta'; tabId: string; messageId: string; delta: string }
  | { type: 'tool_call_start'; tabId: string; messageId: string; block: ToolCallBlock }
  | { type: 'tool_call_result'; tabId: string; messageId: string; toolCallId: string; result: ToolResultPayload; status: ToolCallBlock['status'] }
  | { type: 'user_message'; tabId: string; message: ChatMessage }
  | { type: 'message_start'; tabId: string; message: ChatMessage }
  | { type: 'message_end'; tabId: string; messageId: string; usage?: ChatMessage['usage'] }
  | { type: 'turn_end'; tabId: string }
  | { type: 'error'; tabId: string; message: string }
  | { type: 'pending_action'; tabId: string; action: PendingAction }
  | { type: 'pending_action_resolved'; tabId: string; actionId: string }
  | { type: 'pending_question'; tabId: string; question: PendingQuestion }
  | { type: 'pending_question_resolved'; tabId: string; questionId: string }
  | { type: 'subagent_update'; tabId: string; run: SubagentRun }
  | { type: 'compaction'; tabId: string; summaryMessageId: string }
  | { type: 'spend_update'; tabId: string; totalCostUsd: number; capUsd: number | null }
  | { type: 'spend_blocked'; tabId: string }

export const CURATED_MODEL_IDS = [
  'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.5',
  'google/gemini-3-pro'
]

export const DEFAULT_MAIN_MODEL = 'anthropic/claude-sonnet-5'
export const DEFAULT_SUBAGENT_MODEL = 'anthropic/claude-sonnet-5'
