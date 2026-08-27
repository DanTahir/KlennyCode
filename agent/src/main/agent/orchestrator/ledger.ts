// Verification ledger: the machine-maintained, authoritative record of which tools *actually*
// ran, used both as injected context for the model and as ground truth for the fabrication
// detector (see agent/verify/fabrication-detector.ts).
//
// WHY THIS IS DERIVED RATHER THAN SEPARATELY PERSISTED
// ----------------------------------------------------
// Everything here is recomputed from `tab.messages` on demand instead of being accumulated into
// its own append-only structure. That's deliberate:
//   - `tab.messages` is the same array the UI renders and the session store persists, and
//     compaction never mutates it in place (it only sets compactedThroughMessageId/
//     compactionSummary), so a derived ledger automatically survives compaction *and* an app
//     restart with zero extra bookkeeping.
//   - A separate mutable ledger is one more thing that can silently drift out of sync with what
//     really happened — which is precisely the failure class this whole feature exists to catch.
//     A derived view cannot drift: if a tool call isn't in the message history, it didn't happen.
//
// IMPORTANT — read tool calls off ASSISTANT messages, not `role: 'tool'` messages. Each executed
// call is recorded twice in history (see orchestrator/loop.ts): once on the assistant message
// that requested it (carrying the real parsed `args`, with status/result mutated in place as the
// call completes), and once as a standalone `role: 'tool'` message whose mirrored block
// deliberately has `args: {}`. Collecting from assistant messages therefore yields exactly one
// entry per call *with* usable arguments; collecting from both would double-count everything.
import type { ChatMessage, ToolCallBlock, ToolName } from '@shared/types'

/** One real, executed (or attempted) tool call. `n` is a 1-based position within the current
 *  turn, so the injected digest can be referred to unambiguously ("call #3"). */
export interface LedgerEntry {
  n: number
  toolName: string
  /** JSON-ish preview of the call's arguments, truncated — enough to tell two calls to the same
   *  tool apart without bloating the injected note. */
  argsDigest: string
  status: ToolCallBlock['status']
  at: number
}

/** Paths touched by a tool call, with the status of the attempt that touched them. Status is
 *  deliberately retained rather than filtered down to 'success' only: the fabrication detector's
 *  artifact check must NOT flag honest narration like "I tried to write X but the approval was
 *  rejected" / "the write failed" — an attempt is still evidence the model wasn't inventing the
 *  action, which is the only thing that check is trying to establish. */
export interface PathTouch {
  path: string
  toolName: string
  status: ToolCallBlock['status']
}

const MAX_ARGS_DIGEST_CHARS = 120
/** Cap on how many entries the injected digest lists. A long turn can accumulate hundreds of
 *  calls; the model only needs the recent shape of what ran plus an explicit note that earlier
 *  calls were elided, and the note lives in the uncached trailing slot where size costs real
 *  tokens every single request. */
const MAX_DIGEST_ENTRIES = 25

/** Tools that create or modify something addressable by path. Used only by the artifact-existence
 *  check, so this is intentionally about "did the model attempt to bring this file into being",
 *  not about mutation in general (delete_file is excluded — a claim that a file was *deleted* is
 *  not a claim that it exists). */
const WRITE_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  'write_file',
  'edit_file',
  'multi_edit',
  'multi_write',
  'write_docx',
  'edit_docx',
  'write_skill',
  'write_subagent',
  'write_memory',
  'create_pawprint',
  'update_pawprint',
  'save_plan'
])

/** Checklist bookkeeping tools. These are excluded when deciding whether a turn did any *real*
 *  work, since marking a checklist item done is the claim being audited — it can't also serve as
 *  its own supporting evidence (see the plan-gate evidence requirement in loop.ts). */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set<ToolName>([
  'create_checklist',
  'update_checklist'
])

function isAssistantToolCallBearer(m: ChatMessage): boolean {
  return m.role === 'assistant'
}

function toolCallBlocksOf(m: ChatMessage): ToolCallBlock[] {
  return m.blocks.filter((b): b is ToolCallBlock => b.type === 'tool_call')
}

function digestArgs(args: Record<string, unknown>): string {
  let s: string
  try {
    s = JSON.stringify(args) ?? ''
  } catch {
    s = '<unserializable>'
  }
  return s.length > MAX_ARGS_DIGEST_CHARS ? `${s.slice(0, MAX_ARGS_DIGEST_CHARS)}…` : s
}

/**
 * Index of the message that starts the current turn: the most recent *real* user message.
 *
 * Audit notes (see loop.ts's forced-correction injection) are `role: 'user'` on the wire — they
 * have to be, since toORMessages() only emits system messages for the prompt/summary prefix — but
 * they are NOT a turn boundary. Treating one as a boundary would reset the ledger to empty at
 * exactly the moment it matters most: the correction turn immediately after a fabrication was
 * caught, where the whole point is to show the model the (unchanged, still-mostly-empty) real
 * call list backing the claims it just made. Hence the isAuditNote skip.
 */
function lastTurnStartIdx(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' && !m.isAuditNote) return i
  }
  return -1
}

/** Every tool call recorded since the last real user message, in order. */
export function buildTurnLedger(messages: ChatMessage[]): LedgerEntry[] {
  const start = lastTurnStartIdx(messages)
  const out: LedgerEntry[] = []
  let n = 0
  for (let i = start + 1; i < messages.length; i++) {
    const m = messages[i]
    if (!isAssistantToolCallBearer(m)) continue
    for (const tc of toolCallBlocksOf(m)) {
      n++
      out.push({
        n,
        toolName: tc.toolName,
        argsDigest: digestArgs(tc.args),
        status: tc.status,
        at: m.createdAt
      })
    }
  }
  return out
}

/** True if this turn made at least one tool call that isn't pure checklist bookkeeping. */
export function turnHasSubstantiveToolCall(entries: LedgerEntry[]): boolean {
  return entries.some((e) => !BOOKKEEPING_TOOLS.has(e.toolName))
}

/** Distinct tool names present in a ledger, for fast membership checks by the detector. */
export function toolNamesIn(entries: LedgerEntry[]): Set<string> {
  return new Set(entries.map((e) => e.toolName))
}

function collectPathsFromArgs(toolName: string, args: Record<string, unknown>, into: PathTouch[], status: ToolCallBlock['status']): void {
  const push = (p: unknown): void => {
    if (typeof p === 'string' && p.trim()) into.push({ path: p.trim(), toolName, status })
  }
  push(args.path)
  // multi_edit carries a per-edit path array (with an optional top-level `path` default, already
  // captured above) — see tools/file-ops.ts.
  const edits = args.edits
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e && typeof e === 'object') push((e as Record<string, unknown>).path)
    }
  }
  // multi_write carries a per-file path array. Mirrors normalizeFilesArg's tolerance (file-ops.ts)
  // just enough for C3's purposes: the point is to record every path the model *attempted* to
  // bring into being, so a batch sent in one of the odd-but-accepted shapes (key aliases, or a
  // path->content map instead of an array) must still register here — otherwise a file that was
  // genuinely written gets hard-flagged as a fabricated artifact.
  const files = args.files
  if (Array.isArray(files)) {
    for (const f of files) {
      if (!f || typeof f !== 'object') continue
      const rec = f as Record<string, unknown>
      const alias = ['path', 'file', 'file_path', 'filePath', 'filepath', 'filename', 'fileName', 'name'].find((k) =>
        Object.prototype.hasOwnProperty.call(rec, k)
      )
      if (alias) push(rec[alias])
    }
  } else if (files && typeof files === 'object') {
    // path -> content map form: the keys are the paths.
    for (const key of Object.keys(files as Record<string, unknown>)) push(key)
  }
}

/**
 * Whole-session view of every path any write-ish tool *attempted* to bring into being, regardless
 * of outcome. Session-scoped rather than turn-scoped on purpose: a file legitimately written 20
 * turns ago is still a real artifact the model may correctly mention now, and re-flagging it just
 * because the write is no longer in the current turn's ledger would be a pure false positive.
 */
export function buildSessionWritePaths(messages: ChatMessage[]): PathTouch[] {
  const out: PathTouch[] = []
  for (const m of messages) {
    if (!isAssistantToolCallBearer(m)) continue
    for (const tc of toolCallBlocksOf(m)) {
      if (!WRITE_TOOLS.has(tc.toolName)) continue
      collectPathsFromArgs(tc.toolName, tc.args, out, tc.status)
    }
  }
  return out
}

/**
 * The injected, model-facing rendering of the turn ledger. Framed explicitly as harness-generated
 * so the model treats it as external ground truth rather than as its own recollection — the same
 * framing that made the re-injected checklist state effective at contradicting a false completion
 * claim (see the CoFrame fabrication incident write-up).
 *
 * Cache note: this text goes into buildCurrentTimeNote's already-uncached trailing slot, never
 * into buildSystemPrompt()'s cached prefix. See buildCurrentTimeNote's doc comment.
 */
export function buildLedgerDigest(entries: LedgerEntry[]): string {
  if (entries.length === 0) {
    return 'Tool calls actually made so far this turn (machine-maintained by the harness, authoritative — not your own recollection): NONE. No tool has been called yet this turn. Any statement you make implying you already ran a command, read/wrote a file, or updated the checklist this turn would therefore be false.'
  }
  const shown = entries.slice(-MAX_DIGEST_ENTRIES)
  const elided = entries.length - shown.length
  const lines = shown.map((e) => `${e.n}. ${e.toolName}(${e.argsDigest}) → ${e.status}`)
  const header = `Tool calls actually made so far this turn (machine-maintained by the harness, authoritative — not your own recollection), ${entries.length} total${elided > 0 ? `, showing the most recent ${shown.length}` : ''}:`
  return `${header}\n${lines.join('\n')}\n\nThis list is complete and generated from real execution records. If you are about to describe an action that is not represented above, do not describe it as done.`
}
