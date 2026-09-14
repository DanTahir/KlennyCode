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
 * Why a generation's tool-call arguments failed to JSON.parse.
 *
 *  'none'      — every call's arguments parsed fine.
 *  'truncated' — arguments didn't parse AND the provider reported hitting the output token limit.
 *  'invalid'   — arguments didn't parse and the provider did NOT report 'length'.
 *
 * Both failure kinds are recoverable by retrying, and that is exactly why this replaced the old
 * `isTruncatedToolCallJson`, which gated the retry on `finishReason === 'length'`. A cut-off
 * argument payload was therefore only ever recovered when the provider labelled it correctly —
 * and it frequently isn't: a stream can end with no finish_reason at all (see the missing-[DONE]
 * path in openrouter/client.ts), and some upstreams report 'stop'/'tool_calls' even after
 * truncating. In those cases the turn died on an opaque "Invalid JSON args" tool error instead of
 * retrying, which presented as "multi_write/multi_edit is broken" and correlated only loosely
 * with batch size (reasoning tokens and per-request provider routing move the real ceiling around
 * turn to turn). Valid JSON is a contract the model owes us regardless of the stop label, so
 * unparsable arguments alone now justify a retry; the kind is kept only to word the log line and
 * the retry nudge accurately.
 */
export type ToolArgsFailureKind = 'none' | 'truncated' | 'invalid'

export function classifyToolCallJsonFailure(
  finishReason: string | undefined,
  anyArgsUnparsable: boolean
): ToolArgsFailureKind {
  if (!anyArgsUnparsable) return 'none'
  return finishReason === 'length' ? 'truncated' : 'invalid'
}

/**
 * Best-effort structural check for "this JSON text stops in the middle of itself" — it ends inside
 * an unterminated string, or with objects/arrays still unclosed.
 *
 * Used ONLY to word an error message and to decide whether to advise splitting a batch. It is
 * deliberately never used to attempt a repair: completing a truncated write argument into
 * syntactically valid JSON would write a half-finished file to disk (`{"content":"half a fi` ->
 * a real file containing `half a fi`), which is strictly worse than failing the call outright.
 */
export function looksLikeTruncatedJson(raw: string): boolean {
  const s = raw.trim()
  if (!s) return false
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
  }
  return inString || depth > 0
}

/** How much of the argument payload's tail to quote back in diagnostics. Enough to see where it
 *  stopped, short enough not to dump a whole file into the transcript. */
const ARGS_TAIL_CHARS = 80

/**
 * The tool-result summary for a call whose arguments never parsed. Replaces the old bare
 * 'Invalid JSON args', which named neither the tool, nor the size, nor the cause, nor what to do
 * differently — so it read like an internal bug rather than "that payload was too big, send less".
 */
export function describeToolArgsFailure(toolName: string, raw: string): string {
  const len = raw.length
  const cause =
    len === 0
      ? 'no arguments were received at all'
      : looksLikeTruncatedJson(raw)
        ? "they stop mid-JSON, so the payload was almost certainly cut off at the model's output token limit"
        : 'they are not valid JSON'
  const tail = len > 0 ? ` Last characters received: ${JSON.stringify(raw.slice(-ARGS_TAIL_CHARS))}.` : ''
  return (
    `${toolName}: the tool-call arguments never arrived as valid JSON — ${cause} (${len} chars received). ` +
    `Nothing was executed and no file was touched.${tail} ` +
    'Re-send this call; if it was a large batch (multi_write/multi_edit), split it into several smaller calls.'
  )
}

/**
 * The harness-authored nudge injected before a truncation/invalid-args retry.
 *
 * Without it the retry re-issues a byte-identical request (same messages, no feedback), so the
 * model tends to reproduce the same oversized output until MAX_TRUNCATION_RETRIES is exhausted
 * and the turn hard-fails. Telling it *what* happened and *what to do differently* is what makes
 * the retry actually likely to succeed rather than just costing three more round-trips.
 */
export function buildToolArgsRetryNudge(
  kind: 'truncated' | 'invalid' | 'empty',
  toolNames: string[] = []
): string {
  const header = 'Automatic retry notice (written by the harness, not by the user):'
  if (kind === 'empty') {
    return [
      header,
      '',
      'Your previous response was cut off at the output token limit before it produced any text or any tool call, so nothing was executed. That attempt has been discarded and you are being re-run on the same request.',
      '',
      'Keep this attempt tighter: go straight to the tool calls you need instead of a long preamble.'
    ].join('\n')
  }
  const names = [...new Set(toolNames)].filter(Boolean)
  const which = names.length ? ` (${names.join(', ')})` : ''
  const plural = names.length === 1 ? '' : 's'
  const cause =
    kind === 'truncated'
      ? 'was cut off at the output token limit'
      : 'did not arrive as valid JSON — most likely cut off mid-generation, even though the provider did not report hitting the limit'
  return [
    header,
    '',
    `Your previous tool call${plural}${which} could not be executed: the arguments payload ${cause}. Nothing ran, no file was created or modified, and that attempt has been discarded.`,
    '',
    'Re-issue the work now, in smaller pieces. Concretely:',
    '- If it was a batch (multi_write / multi_edit), split it into several calls of a few files each rather than one large one.',
    '- Prefer multi_edit over multi_write when changing part of an existing file: sending only the changed fragments costs far fewer output tokens than re-sending whole files.',
    '- Skip any preamble before the call so the whole output budget goes to the arguments.'
  ].join('\n')
}

/** How many times one turn may be auto-resumed after context compaction ended a step with no
 *  tool calls. Exactly one: the resume exists to get past a single "the summary looked like a
 *  wrap-up point" stall, not to argue with a model that has genuinely decided it is finished. */
export const MAX_COMPACTION_RESUMES = 1

/**
 * Whether the turn should be resumed instead of ending as a clean 'natural' completion, at the
 * no-tool-calls exit of a step where compaction ran.
 *
 * Background: compaction injects a summary system message mid-turn, and models routinely read
 * that as a natural stopping point — replying with a short text-only progress note and no tool
 * calls. The orchestrator cannot distinguish that from a genuinely finished task, so the turn
 * ends silently mid-work and the user just sees the spinner stop. This was observed three times
 * in one session, always at a phase boundary with an unfinished checklist.
 *
 * The prior mitigation was prompt-only (a one-shot cue appended to the summary when
 * `justCompacted`), and prompt-only is exactly what failed: the cue reaches the model for
 * exactly ONE request, and if that reply has no tool calls there is no retry, no event and no
 * warning. Worse, the cue asked for a one-sentence acknowledgment, which primes the very
 * text-only-reply shape that triggers the stop. Hence this harness-owned structural check.
 *
 * Deliberately conservative — an unfinished checklist is required. With no checklist (or a fully
 * checked one) there is no harness-side evidence that work remains, and forcing another step
 * would just pressure the model to invent something to do. `compactedThisStep` must be the
 * compaction result for THIS step, which is why the caller has to carry the resume count across
 * the recursion: on the resumed step `maybeCompact` returns false (already summarized through
 * that point), so "did compaction fire" is not recoverable after the fact.
 */
export function shouldResumeAfterCompaction(opts: {
  compactedThisStep: boolean
  unfinishedChecklistItems: number
  compactionResumes: number
  /** True when the fabrication guard already forced a self-correction turn for this message —
   *  that recursion takes precedence, so the resume must not also fire and double-recurse. */
  auditForcedCorrection: boolean
}): boolean {
  const { compactedThisStep, unfinishedChecklistItems, compactionResumes, auditForcedCorrection } = opts
  if (!compactedThisStep) return false
  if (unfinishedChecklistItems <= 0) return false
  if (auditForcedCorrection) return false
  return compactionResumes < MAX_COMPACTION_RESUMES
}

/**
 * The harness-authored note injected before a post-compaction resume.
 *
 * Careful with the wording: this fires precisely when the model believes it is done, so it must
 * push the work forward WITHOUT pressuring it to claim progress it hasn't made. Hence the
 * explicit escape hatch (say so plainly if genuinely complete/blocked) and the explicit
 * reminder not to mark checklist items done unverified — a nudge that only said "keep going"
 * would trade a silent stop for a fabricated completion.
 */
export function buildCompactionResumeNudge(opts: { unfinishedItems: number; nextItem?: string }): string {
  const { unfinishedItems, nextItem } = opts
  const plural = unfinishedItems === 1 ? '' : 's'
  const next = nextItem ? ` The next unfinished item is: "${nextItem}".` : ''
  return [
    'Automatic continuation notice (written by the harness, not by the user):',
    '',
    `Your context was compacted earlier in this turn, and your reply just now contained no tool calls — which would normally end the turn. But the live checklist still has ${unfinishedItems} unfinished item${plural}, so the task does not look finished.${next}`,
    '',
    'Compaction is routine background maintenance, not a stopping point, so the turn has been resumed for you automatically. Pick the work back up now: put the next concrete tool call in this reply. Do not re-summarize what you have already done, and do not stop again for the same reason.',
    '',
    'If the remaining work is genuinely complete, genuinely blocked, or actually needs a decision from the user, then say so plainly and explain why — that is a perfectly good answer here. What you must not do is mark anything done that you have not actually verified, or describe work you have not actually performed. This notice is a request to continue, never a request to claim progress.'
  ].join('\n')
}
