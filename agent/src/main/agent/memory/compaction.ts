import type { ModelInfo } from '@shared/types'
import { runUtilityPrompt } from '../../openrouter/client'
import { modelSupportsCaching } from '../../openrouter/caching'
import {
  readAllMemoryTopics,
  backupMemoryTopics,
  replaceMemoryTopics,
  loadProjectMemory,
  loadGlobalMemory
} from './manager'

/** User-requested hard cap on how much raw input a single compaction pass is allowed to see,
 *  regardless of how large the chosen model's context window is. */
const HARD_CHAR_CAP = 500_000

/** Conservative fallback when a model doesn't report `maxCompletionTokens` at all. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000

/** Rough chars-per-token ratio used for all budget math here — matches the heuristic already
 *  used elsewhere in the codebase (compaction.ts's estimateTokensHeuristic, assistant memory pool). */
const CHARS_PER_TOKEN = 4

/** Target compaction ratio requested by the user: aim for the rewritten notes to land around
 *  1/3 the size of whatever was fed in for that pass. */
const TARGET_COMPACTION_RATIO = 1 / 3

/** Leaves room in a pass's input budget for the system prompt + any KLENNY.md context, so the
 *  the total request (system + KLENNY.md + user content) doesn't itself blow past the model's
 *  context window. */
const RESERVED_OVERHEAD_TOKENS = 2_000

/** How much of KLENNY.md (if any) to include as read-only context per pass, in characters. */
const MAX_KLENNY_CONTEXT_CHARS = 20_000

export interface MemoryCompactionResult {
  scope: 'project' | 'global'
  /** number of auto-memory topic notes that existed before compaction */
  beforeCount: number
  /** number of auto-memory topic notes that exist after compaction */
  afterCount: number
  beforeChars: number
  afterChars: number
  /** how many model calls (passes) the compaction took */
  passes: number
  /** absolute path of the pre-compaction backup snapshot, or null if there was nothing to compact */
  backupPath: string | null
}

/** In-memory representation of one pass's input/output note set — same shape as what the
 *  memory manager reads/writes, kept separate from disk until the whole run succeeds. */
interface Note {
  topic: string
  content: string
}

/**
 * Computes the maximum number of characters of *raw* topic-note text that a single compaction
 * pass may be given as input, for a given model. Bounded by three independent ceilings:
 *  - the user-configured hard cap (500,000 chars)
 *  - the model's context window (leaving room for output + overhead)
 *  - the model's max *output* tokens × 3 — since we're asking for ~33% compaction, whatever goes
 *    in for a pass must produce output that still fits under the model's own completion-token cap,
 *    or the rewrite will get truncated instead of actually finishing.
 */
export function computePassCharBudget(model: ModelInfo): number {
  const maxOutputTokens = model.maxCompletionTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const outputDrivenTokenBudget = maxOutputTokens / TARGET_COMPACTION_RATIO // maxOutputTokens * 3
  const contextDrivenTokenBudget = model.contextLength * 0.75 - RESERVED_OVERHEAD_TOKENS
  // Floor at 1 token just to avoid a zero/negative budget stalling the chunking loop — deliberately
  // NOT clamped up to some larger minimum, since a genuinely small output-token cap must keep the
  // per-pass input small too (see this function's doc comment for why 3x output tokens matters).
  const tokenBudget = Math.max(1, Math.min(outputDrivenTokenBudget, contextDrivenTokenBudget))
  const charBudget = tokenBudget * CHARS_PER_TOKEN
  return Math.min(HARD_CHAR_CAP, Math.floor(charBudget))
}

function noteBlockText(notes: Note[]): string {
  return notes.map((n) => `### TOPIC: ${n.topic}\n${n.content.trim()}`).join('\n\n---\n\n')
}

/** Parses the model's `### TOPIC: <title>` delimited response back into discrete notes. Falls
 *  back to treating the entire response as one note (rather than throwing/losing data) if the
 *  model didn't follow the format — logged so it's visible during development/debugging. */
function parseNoteBlocks(raw: string): Note[] {
  const notes: Note[] = []
  const re = /^###\s*TOPIC:\s*(.+?)\s*$/gim
  const matches = [...raw.matchAll(re)]
  if (matches.length === 0) {
    const trimmed = raw.trim()
    if (!trimmed) return []
    console.warn('[memory-compaction] model response had no "### TOPIC:" markers — keeping it as a single note')
    return [{ topic: 'Compacted memory', content: trimmed }]
  }
  for (let i = 0; i < matches.length; i++) {
    const topic = matches[i][1].trim()
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index ?? raw.length : raw.length
    const content = raw.slice(start, end).replace(/^\s*---\s*$/gim, '').trim()
    if (topic && content) notes.push({ topic, content })
  }
  return notes
}

const COMPACTION_SYSTEM_PROMPT = `You are compacting a coding agent's own auto-memory notes — short markdown files it wrote for itself about past work, bugs, and decisions in a project. Your job: rewrite the provided notes into a smaller set of cleaner, non-redundant notes.

Rules:
- Preserve every concrete, still-relevant fact: file paths, function/variable names, bug root causes, decisions made and why, and anything a future session would need to avoid repeating work or re-introducing a fixed bug.
- Merge notes that describe the same feature/area evolving over time (e.g. "X implemented" + "X bug fix" + "X follow-up fix") into one note reflecting the current, final state — mention the history briefly only if it's instructive (e.g. "previously broke Y because Z; fixed by...").
- Drop notes that are now fully superseded, obsolete, or no longer relevant (e.g. a feature that was later removed and the removal note already exists) — but say what you dropped is safe to drop only when the provided notes make that clear; never guess.
- Never invent facts, file paths, function names, or outcomes that are not present in the provided notes. If something is ambiguous or contradictory across notes, keep the more recent/specific version and note the ambiguity rather than silently picking one.
- Target roughly one third of the total input size across all your output notes combined, but never omit a genuinely load-bearing fact just to hit that number — the target is a guideline, not a hard requirement.
- Output ONLY the rewritten notes, each formatted exactly like this, with nothing before, between, or after except this exact format:

### TOPIC: <short descriptive title>
<note content in markdown>

### TOPIC: <next title>
<note content>

Do not include any preamble, explanation, or summary of what you changed — only the "### TOPIC:" blocks themselves.`

/**
 * Runs the full multi-pass memory compaction pipeline for one scope:
 *  1. Reads all current auto-memory topic notes.
 *  2. Iteratively feeds them (in budget-sized chunks, per `computePassCharBudget`) to the utility
 *     model, folding each pass's already-compacted output together with the next raw chunk so
 *     the model always compacts against everything seen so far, not just the newest chunk.
 *  3. Only once every pass has succeeded, snapshots the pre-compaction notes to a backup folder
 *     and atomically replaces the on-disk topic set with the final compacted notes.
 * Nothing on disk changes if any pass throws — all model calls must succeed before any file is
 * touched, so a partial failure just leaves the existing notes exactly as they were.
 */
export async function compactProjectOrGlobalMemory(opts: {
  scope: 'project' | 'global'
  apiKey: string
  utilityModel: string
  models: ModelInfo[]
  workspace?: string
  signal?: AbortSignal
  promptCachingEnabled?: boolean
}): Promise<MemoryCompactionResult> {
  const { scope, apiKey, utilityModel, models, workspace, signal, promptCachingEnabled } = opts

  const existing = await readAllMemoryTopics(scope, workspace)
  const beforeChars = existing.reduce((sum, n) => sum + n.content.length, 0)

  if (existing.length === 0) {
    return { scope, beforeCount: 0, afterCount: 0, beforeChars: 0, afterChars: 0, passes: 0, backupPath: null }
  }

  const modelInfo = models.find((m) => m.id === utilityModel) ?? models[0]
  if (!modelInfo) throw new Error('No models available to run memory compaction — check your API key / model list.')
  const supportsExplicitCaching =
    Boolean(promptCachingEnabled) && modelInfo.supportsExplicitCaching && modelSupportsCaching(modelInfo)
  const maxOutputTokens = modelInfo.maxCompletionTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const passCharBudget = computePassCharBudget(modelInfo)

  const klennyContext = (scope === 'project' ? await loadProjectMemory(workspace) : await loadGlobalMemory())
    .slice(0, MAX_KLENNY_CONTEXT_CHARS)
    .trim()

  let running: Note[] = []
  let passes = 0
  let cursor = 0

  while (cursor < existing.length) {
    const runningText = noteBlockText(running)
    const availableForChunk = Math.max(passCharBudget - runningText.length, passCharBudget * 0.2)

    const chunk: Note[] = []
    let chunkChars = 0
    while (cursor < existing.length) {
      const next = existing[cursor]
      const nextLen = next.content.length + next.topic.length
      // Always take at least one note per chunk (even if it alone exceeds budget) so an
      // unusually large single note can't stall the loop forever.
      if (chunk.length > 0 && chunkChars + nextLen > availableForChunk) break
      chunk.push(next)
      chunkChars += nextLen
      cursor++
    }

    const parts: string[] = []
    if (klennyContext) {
      parts.push(
        `Read-only project context already captured in KLENNY.md (do not duplicate this back into your output, it's shown only so you know what's already covered elsewhere):\n${klennyContext}`
      )
    }
    if (running.length > 0) {
      parts.push(`Already-compacted notes from earlier in this run (fold these in, don't just repeat them verbatim):\n\n${runningText}`)
    }
    parts.push(`${running.length > 0 ? 'Additional raw' : 'Raw'} notes to compact:\n\n${noteBlockText(chunk)}`)

    const userContent = parts.join('\n\n===\n\n')

    const responseText = await runUtilityPrompt({
      apiKey,
      model: modelInfo.id,
      systemPrompt: COMPACTION_SYSTEM_PROMPT,
      userContent,
      signal,
      supportsExplicitCaching,
      maxTokens: maxOutputTokens
    })

    const parsed = parseNoteBlocks(responseText)
    // A pass that produces nothing usable would silently erase memory — treat it as a failure
    // rather than committing an empty result.
    if (parsed.length === 0) {
      throw new Error('Memory compaction pass returned no usable notes — aborting without changing anything on disk.')
    }
    running = parsed
    passes++
  }

  const backupPath = await backupMemoryTopics(scope, workspace)
  await replaceMemoryTopics(scope, running, workspace)
  const afterChars = running.reduce((sum, n) => sum + n.content.length, 0)

  return {
    scope,
    beforeCount: existing.length,
    afterCount: running.length,
    beforeChars,
    afterChars,
    passes,
    backupPath
  }
}
