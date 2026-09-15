/**
 * Persistence-time size guard for chat sessions.
 *
 * Why this exists: a single tool result was able to make a whole workspace's session file
 * unloadable. delete_file on a ~20 MB binary `.mov` produced a 20 MB unified diff of decoded
 * mojibake, that diff was stored in the tool result, and the result was persisted verbatim into
 * `sessions/<workspace>.json`. The file reached 61 MB, which froze the app on its loading screen
 * and froze external editors opening the log.
 *
 * `tools/diff.ts` now clamps diffs at the source, which fixes that specific path. This module is
 * the *backstop*: it makes the invariant structural rather than per-tool, so no future tool
 * (existing, new, or third-party) can push an unbounded payload into a session file just by
 * returning a huge string. Two rules:
 *
 *   1. every string inside a message block is clamped to MAX_PERSISTED_STRING_CHARS;
 *   2. if a tab is still over MAX_PERSISTED_TAB_CHARS afterwards, `result.data` is dropped from
 *      the OLDEST tool calls first, until it fits (recent transcript is what users actually
 *      look at, and `ok`/`summary`/`error` are always kept so the history still reads correctly).
 *
 * Non-negotiable contract: these functions are PURE. They deep-copy on the way out and never
 * mutate the live `TabSession` objects the orchestrator holds. The in-memory transcript stays
 * byte-exact because it feeds `toORMessages()` — clamping it in place would silently rewrite
 * tool-call arguments the model already sent, and change what the model sees on later turns.
 * Only the on-disk artifact is bounded.
 */
import type { ArchivedTabSession, ContentBlock, ChatMessage, TabSession, ToolResultPayload } from '@shared/types'

/** Per-string cap. Generous enough for a real 100K-line-ish diff or a large generated file body,
 *  small enough that no single value can dominate a session file. */
export const MAX_PERSISTED_STRING_CHARS = 64_000
/** Per-tab cap for the persisted JSON. Beyond this, oldest tool-result `data` gets dropped. */
export const MAX_PERSISTED_TAB_CHARS = 4_000_000
/** Recursion limit for the value walk (defensive; tool-result JSON is shallow in practice). */
const MAX_DEPTH = 24

export interface SanitizeStats {
  /** How many individual strings were truncated. */
  clampedStrings: number
  /** How many tool-result `data` payloads were dropped to get a tab under the size budget. */
  strippedResults: number
}

function emptyStats(): SanitizeStats {
  return { clampedStrings: 0, strippedResults: 0 }
}

/** True if anything was actually changed — callers use this to decide whether to log/repair. */
export function wasSanitized(stats: SanitizeStats): boolean {
  return stats.clampedStrings > 0 || stats.strippedResults > 0
}

function clampString(s: string, stats: SanitizeStats): string {
  if (s.length <= MAX_PERSISTED_STRING_CHARS) return s
  stats.clampedStrings++
  const dropped = s.length - MAX_PERSISTED_STRING_CHARS
  return `${s.slice(0, MAX_PERSISTED_STRING_CHARS)}\u2026[truncated for the session log: ${dropped} more chars]`
}

/** Recursively copies a JSON-ish value, clamping every string. Non-plain values (numbers,
 *  booleans, null) pass through untouched. */
function sanitizeValue(v: unknown, stats: SanitizeStats, depth = 0): unknown {
  if (typeof v === 'string') return clampString(v, stats)
  if (depth >= MAX_DEPTH || v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map((item) => sanitizeValue(item, stats, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = sanitizeValue(val, stats, depth + 1)
  }
  return out
}

function sanitizeBlock(block: ContentBlock, stats: SanitizeStats): ContentBlock {
  switch (block.type) {
    case 'tool_call':
      return {
        ...block,
        args: sanitizeValue(block.args, stats) as Record<string, unknown>,
        result: block.result ? (sanitizeValue(block.result, stats) as ToolResultPayload) : block.result
      }
    case 'text':
    case 'thinking':
      return { ...block, text: clampString(block.text, stats) }
    case 'document':
      return { ...block, extractedText: clampString(block.extractedText, stats) }
    case 'image':
      // Deliberately exempt. A data URL is one atomic value: truncating it doesn't shrink a
      // problem so much as replace a working thumbnail with a corrupt one. Images are also
      // inherently bounded (a screenshot/generated PNG), unlike a diff of an arbitrary file.
      return block
    default:
      return block
  }
}

function sanitizeMessage(m: ChatMessage, stats: SanitizeStats): ChatMessage {
  return { ...m, blocks: m.blocks.map((b) => sanitizeBlock(b, stats)) }
}

function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0
  } catch {
    return 0
  }
}

/** Second pass: if clamping strings wasn't enough (e.g. thousands of individually-legal 64K
 *  diffs accumulated over a very long session), drop `result.data` from the oldest tool calls
 *  until the tab fits. Keeps `ok`/`summary`/`error` so the transcript still reads correctly. */
function enforceTabBudget<T extends TabSession | ArchivedTabSession>(tab: T, stats: SanitizeStats): T {
  let size = jsonLength(tab)
  if (size <= MAX_PERSISTED_TAB_CHARS) return tab

  const messages = tab.messages.map((m) => ({ ...m, blocks: [...m.blocks] }))
  for (let mi = 0; mi < messages.length && size > MAX_PERSISTED_TAB_CHARS; mi++) {
    const blocks = messages[mi].blocks
    for (let bi = 0; bi < blocks.length && size > MAX_PERSISTED_TAB_CHARS; bi++) {
      const b = blocks[bi]
      if (b.type !== 'tool_call' || !b.result || b.result.data === undefined) continue
      const freed = jsonLength(b.result.data)
      // Not worth the churn for a tiny payload — and avoids growing the file by replacing a
      // small `data` with a longer note.
      if (freed < 400) continue
      blocks[bi] = {
        ...b,
        result: {
          ...b.result,
          data: { dataOmitted: true, note: 'Payload dropped from the session log to keep it loadable.' }
        }
      }
      size -= freed
      stats.strippedResults++
    }
  }
  return { ...tab, messages } as T
}

/** Returns a size-bounded deep copy of `tab`, safe to JSON.stringify to disk. Never mutates
 *  the input (see the module doc comment for why that matters). */
export function sanitizeTabForPersist<T extends TabSession | ArchivedTabSession>(tab: T): { tab: T; stats: SanitizeStats } {
  const stats = emptyStats()
  const messages = Array.isArray(tab.messages) ? tab.messages.map((m) => sanitizeMessage(m, stats)) : []
  const copy = { ...tab, messages } as T
  return { tab: enforceTabBudget(copy, stats), stats }
}

export function sanitizeTabsForPersist<T extends TabSession | ArchivedTabSession>(tabs: T[]): { tabs: T[]; stats: SanitizeStats } {
  const stats = emptyStats()
  const out = tabs.map((t) => {
    const { tab, stats: s } = sanitizeTabForPersist(t)
    stats.clampedStrings += s.clampedStrings
    stats.strippedResults += s.strippedResults
    return tab
  })
  return { tabs: out, stats }
}
