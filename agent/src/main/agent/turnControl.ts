/**
 * Pure decision logic for how long a single agent turn is allowed to run before pausing, and
 * for detecting/recovering from generations truncated by the model provider's output token
 * limit. Kept separate from orchestrator.ts (which wires these decisions into the actual
 * streaming loop) so they're unit-testable without any Electron/network dependencies — same
 * pattern as reasoning.ts and compaction/compactor.ts.
 */

/** Defensive nesting guard. In practice subagentDepth can only ever be 0 (top-level) or 1
 *  (inside a subagent) because the `task` tool is filtered out once already inside a subagent
 *  context — this ceiling exists only to fail loudly if that invariant is ever broken. */
export const MAX_SUBAGENT_DEPTH = 5

/** Always-enforced backstop regardless of continueMode, purely to bound runaway loops/cost.
 *  Far higher than the old accidental ~30-step cap so normal long tasks never hit it. */
export const HARD_STEP_LIMIT = 500

/** Subagents are meant to be bounded exploration/parallel tasks, not open-ended — they have no
 *  UI presence for a "Continue" button, so they get their own small fixed budget instead of the
 *  main loop's checkpoint/hard-limit split. */
export const SUBAGENT_STEP_BUDGET = 60

export const DEFAULT_CHECKPOINT_STEPS = 40

/** Fallback output token cap when a model doesn't report its own `top_provider.max_completion_tokens`
 *  (OpenRouter's /models response) — generous enough to comfortably fit a large multi-file edit's
 *  worth of tool-call JSON or explanatory text without relying on the provider's own default, which
 *  can be conservative and is a common cause of mid-generation truncation. */
export const DEFAULT_MAX_COMPLETION_TOKENS = 16_000

/** How many consecutive truncated-generation retries to attempt before giving up and surfacing
 *  a real error instead of looping forever. */
export const MAX_TRUNCATION_RETRIES = 3

/** Ceiling on a subagent's final summary text returned to the parent as the `task` tool result.
 *  Raised from an old hard 8000-char cap (which silently dropped content with no indication)
 *  to a much more generous limit — still bounds parent-context growth from a single subagent
 *  run, but comfortably fits typical subagent output. When actually exceeded, callers should
 *  use `truncateSummary` below, which appends an explicit marker instead of cutting silently. */
export const MAX_SUBAGENT_SUMMARY_CHARS = 24_000

export type PauseReason = 'checkpoint' | 'hard_limit'

/**
 * Truncates a subagent's summary text to `maxChars`, appending a clear, visible marker stating
 * how many characters were removed when truncation actually occurs — so neither the parent
 * agent nor the user mistakes a cut-off answer for a complete one. Returns the text unmodified
 * (no marker) when it's already within the limit.
 */
export function truncateSummary(summary: string, maxChars: number = MAX_SUBAGENT_SUMMARY_CHARS): string {
  if (summary.length <= maxChars) return summary
  const omitted = summary.length - maxChars
  return `${summary.slice(0, maxChars)}\n\n[...${omitted} characters truncated...]`
}

/**
 * Decides whether the main (non-subagent) loop should pause before starting another step.
 * `stepCount` is the number of tool-round-trips already completed in this turn.
 */
export function checkStepLimit(opts: {
  stepCount: number
  continueMode: 'auto' | 'checkpoint'
  checkpointSteps: number
}): PauseReason | null {
  const { stepCount, continueMode, checkpointSteps } = opts
  if (stepCount >= HARD_STEP_LIMIT) return 'hard_limit'
  if (continueMode === 'checkpoint' && stepCount >= Math.max(1, checkpointSteps)) return 'checkpoint'
  return null
}

/** Subagents always enforce their own fixed budget, independent of the user's continueMode setting. */
export function isSubagentBudgetExceeded(stepCount: number): boolean {
  return stepCount >= SUBAGENT_STEP_BUDGET
}

/**
 * A generation that ended with no tool calls and no text, but was cut off by the provider's
 * token limit, used to look identical to a normal "model is done" stop. This flags that case
 * so the caller can retry instead of silently ending the turn.
 */
export function isTruncatedEmpty(finishReason: string | undefined, hasToolCalls: boolean, hasText: boolean): boolean {
  return finishReason === 'length' && !hasToolCalls && !hasText
}

/**
 * A generation that produced tool calls but got cut off mid tool-call-arguments JSON used to
 * dispatch the tool with empty/garbage args and a confusing "Invalid JSON args" error. This
 * flags that case so the caller can discard the attempt and retry instead.
 */
export function isTruncatedToolCallJson(finishReason: string | undefined, anyArgsUnparsable: boolean): boolean {
  return finishReason === 'length' && anyArgsUnparsable
}
