// Pure, Electron-free logic for the Assistant-window shared memory pool: token estimation,
// compaction planning, and digest formatting. Kept dependency-free so it's directly
// unit-testable, mirroring the compaction/compactor.ts + messages.ts split used for the main
// chat-history compaction feature. All Electron-touching orchestration (file IO, mutex, utility
// model calls) lives in assistantMemory.ts, which calls into this module.
import type { AssistantMemoryRollup, AssistantMemorySize, AssistantMemorySlot } from '@shared/types'

/** Fraction of the aggregate budget reserved for the newest, still-granular slots — everything
 *  older than this cutoff (plus any existing rollup) gets folded into a single rolled-up note.
 *  See the plan's "Key Design Decisions" #3. */
const NEWEST_FRACTION = 0.4

/** Hard ceiling on the rolled-up note's estimated size, enforced regardless of what the
 *  summarization model actually produces — a safeguard against non-compliant output ballooning
 *  the rollup indefinitely across repeated compaction passes. */
export const ROLLUP_TOKEN_CEILING = 2000

/** Same char/4 heuristic used by compaction/compactor.ts's estimateTokensHeuristic, reused here
 *  for plain strings (slot/rollup content) rather than ChatMessage arrays. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface CompactionPlan {
  /** true iff there's anything to actually do this pass (slots to fold, or nothing changes) */
  needsCompaction: boolean
  /** slots that must be merged into the rollup and removed from the pool's slot list */
  toCompact: AssistantMemorySlot[]
  /** slots that stay as granular, individually-addressable entries */
  toKeep: AssistantMemorySlot[]
}

/** Orders slots by recency (newest first), tiebreaking on tabId for determinism when two slots
 *  share the exact same updatedAt (e.g. in tests, or two tabs finishing in the same tick). */
export function sortSlotsByRecency(slots: AssistantMemorySlot[]): AssistantMemorySlot[] {
  return [...slots].sort((a, b) => {
    if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
    return a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0
  })
}

/**
 * Walks slots newest-first, accumulating token estimates, until the running total would exceed
 * `budgetTokens * NEWEST_FRACTION`. Everything at/after that cutoff point is flagged for
 * compaction into the rollup; everything before it stays granular. Applying this exact formula
 * against whatever the *current* budget is (rather than tracking a separate "have we already
 * compacted for this budget" flag) is what makes a settings downsize self-correct on the very
 * next write with no special-casing — see the plan's risk table.
 *
 * `budgetTokens` should never be called for a 'disabled' pool — callers must skip this entirely
 * when settings.assistantMemorySize === 'disabled'.
 */
export function selectCompactionPlan(slots: AssistantMemorySlot[], rollup: AssistantMemoryRollup | null, budgetTokens: number): CompactionPlan {
  const ordered = sortSlotsByRecency(slots)
  const newestCutoff = budgetTokens * NEWEST_FRACTION

  const toKeep: AssistantMemorySlot[] = []
  const toCompact: AssistantMemorySlot[] = []
  let running = 0
  for (const slot of ordered) {
    if (running + slot.tokenEstimate <= newestCutoff) {
      toKeep.push(slot)
      running += slot.tokenEstimate
    } else {
      toCompact.push(slot)
    }
  }

  // Total pool size (kept slots + rollup) is used only to decide whether there's anything worth
  // doing at all — folding zero slots into an already-empty rollup is a no-op.
  const needsCompaction = toCompact.length > 0

  return { needsCompaction, toCompact, toKeep }
}

/**
 * Formats the pool into the trailing digest block injected into another Assistant tab's system
 * prompt (or returned verbatim to `read_memory('assistant')`). `excludeTabId`, when given, drops
 * that tab's own slot — callers never show a tab its own memory (see the plan's cache-safety
 * rationale: a tab's own slot changing must never appear in its own prompt, since that's exactly
 * the content that would otherwise vary turn to turn under a cached prefix).
 *
 * Returns '' when there's nothing to show (empty pool after exclusion, and no rollup).
 */
export function formatDigest(slots: AssistantMemorySlot[], rollup: AssistantMemoryRollup | null, excludeTabId?: string): string {
  const visible = sortSlotsByRecency(slots.filter((s) => s.tabId !== excludeTabId))
  if (visible.length === 0 && !rollup) return ''

  const lines: string[] = []
  for (const slot of visible) {
    lines.push(`- [${slot.tabTitle}] (updated ${formatRelativeTime(slot.updatedAt)} ago): ${slot.content}`)
  }

  const parts: string[] = []
  if (lines.length > 0) parts.push(lines.join('\n'))
  if (rollup) parts.push(`Older Assistant-window history:\n${rollup.content}`)
  return parts.join('\n\n')
}

export function formatRelativeTime(ts: number): string {
  const deltaMs = Math.max(Date.now() - ts, 0)
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  return `${days}d`
}

/** Truncates rollup content down to (approximately) ROLLUP_TOKEN_CEILING tokens, appended with
 *  a marker, if the summarization model didn't comply with the "stay bounded" instruction. */
export function enforceRollupCeiling(content: string): string {
  if (estimateTokens(content) <= ROLLUP_TOKEN_CEILING) return content
  const maxChars = ROLLUP_TOKEN_CEILING * 4
  return `${content.slice(0, maxChars)}\n\n[...truncated...]`
}

/** Resolves the numeric token budget for a given setting value, or null when disabled. */
export function budgetTokensFor(size: AssistantMemorySize): number | null {
  return size === 'disabled' ? null : size
}
