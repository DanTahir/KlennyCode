import type { ChatMessage, ModelInfo, ReasoningEffort, TabSession, ToolCallBlock } from '@shared/types'
import { MUTATING_TOOLS } from '@shared/types'

const LEVELS: ReasoningEffort[] = ['low', 'medium', 'high']

/** How many trailing messages to inspect — keeps this O(recent), not O(full history), even on long/compacted sessions. */
const LOOKBACK = 10

/**
 * Picks a reasoning effort level (low/medium/high) for the next turn from signals already
 * resident in `tab.messages` — no extra network calls, no extra latency. Returns `undefined`
 * when the model doesn't support reasoning at all.
 *
 * Never returns anything below 'low' (we never send effort:'none' — see project decision:
 * simpler, and avoids "model rejects disabling reasoning" edge cases on mandatory-reasoning
 * models entirely). The raw score is clamped into whatever effort levels the model itself
 * advertises via `supportedReasoningEfforts`, if that's narrower than the full low/medium/high
 * range (e.g. a model that only supports 'high'/'medium' would never get 'low' picked for it).
 */
export function resolveReasoningEffort(tab: TabSession, modelInfo: ModelInfo): ReasoningEffort | undefined {
  if (!modelInfo.supportsReasoning) return undefined

  const recent = tab.messages.slice(-LOOKBACK)

  // Baseline: index 1 of ['low','medium','high'] = 'medium'.
  let score = 1

  // Plan mode is architecture/design work — bias toward more reasoning.
  if (tab.mode === 'plan') score += 1

  // If the last tool result failed, the model is about to retry/recover — worth more thought
  // than blindly repeating the same approach.
  const lastToolMessage = [...recent].reverse().find((m) => m.role === 'tool')
  const lastToolBlock = lastToolMessage?.blocks.find((b) => b.type === 'tool_call') as ToolCallBlock | undefined
  if (lastToolBlock?.result && lastToolBlock.result.ok === false) score += 1

  // If the most recent prior assistant turn called a mutating tool, the conversation is
  // currently in a "making real changes" phase — worth a bit more caution/effort.
  const lastAssistantMessage = [...recent].reverse().find((m) => m.role === 'assistant')
  const lastAssistantToolNames = (lastAssistantMessage?.blocks.filter((b) => b.type === 'tool_call') as
    | ToolCallBlock[]
    | undefined)?.map((b) => b.toolName)
  if (lastAssistantToolNames?.some((name) => (MUTATING_TOOLS as string[]).includes(name))) score += 1

  // Repeated-loop detection: the last 3 tool-call messages share the same tool + near-identical
  // args — the model appears stuck, so give it more budget to break the loop rather than less.
  // This is a hard floor applied after every other signal (below), not just another +1/-1,
  // since a stuck loop should never be de-escalated back down by, say, a tiny message-size signal.
  const recentToolMessages = recent.filter((m) => m.role === 'tool').slice(-3)
  let loopDetected = false
  if (recentToolMessages.length === 3) {
    const blocks = recentToolMessages.map(
      (m) => m.blocks.find((b) => b.type === 'tool_call') as ToolCallBlock | undefined
    )
    loopDetected =
      blocks.every((b) => b) &&
      blocks.every((b) => b!.toolName === blocks[0]!.toolName) &&
      blocks.every((b) => JSON.stringify(b!.args) === JSON.stringify(blocks[0]!.args))
  }

  // Message/turn size: a large amount of recent context (long user message, big tool
  // results) suggests a meatier task; a tiny/trivial turn suggests the opposite.
  const charEstimate = estimateRecentChars(recent)
  if (charEstimate > 8000) score += 1
  else if (charEstimate < 200) score -= 1

  score = Math.max(0, Math.min(LEVELS.length - 1, score))
  if (loopDetected) score = LEVELS.length - 1 // force 'high', overriding every other signal
  let effort = LEVELS[score]

  // Clamp into the model's own supported set, if it's narrower than the full range.
  const supported = modelInfo.supportedReasoningEfforts
  if (supported && supported.length > 0 && !supported.includes(effort)) {
    // Prefer the closest supported level at or above the picked one; otherwise the highest
    // supported level below it. Never fall back to 'none'/'minimal' even if the model lists
    // them — we never send those.
    const supportedLevels = LEVELS.filter((l) => supported.includes(l))
    if (supportedLevels.length > 0) {
      const pickedIdx = LEVELS.indexOf(effort)
      const above = supportedLevels.filter((l) => LEVELS.indexOf(l) >= pickedIdx)
      effort = above.length > 0 ? above[0] : supportedLevels[supportedLevels.length - 1]
    }
    // If the model advertises no low/medium/high levels at all (e.g. only 'max'/'none'),
    // leave `effort` as the raw pick — the caller's 3-way branch in client.ts will fall back
    // to `enabled: true` in that case since supportedReasoningEfforts won't include it.
  }

  return effort
}

function estimateRecentChars(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    for (const b of m.blocks) {
      if ('text' in b && typeof b.text === 'string') chars += b.text.length
      if (b.type === 'tool_call') {
        chars += JSON.stringify(b.args).length
        if (b.result) chars += JSON.stringify(b.result).length
      }
    }
  }
  return chars
}
