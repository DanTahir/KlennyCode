// Programmatic fabrication detector: cross-checks what an assistant message CLAIMS against the
// harness's own records of what actually happened (the verification ledger, the injected clock,
// the filesystem, and live checklist state).
//
// DESIGN CONSTRAINTS (deliberate, load-bearing)
// --------------------------------------------
// 1. ZERO model calls. Every check here is regex/arithmetic/fs.exists. An LLM-based auditor would
//    add cost and latency to every turn and would itself be a fallible narrator — the whole point
//    of this module is to be a mechanical check that does not depend on model judgment.
// 2. PURE + INJECTED I/O. `fileExists` is passed in, so the entire detector is testable without
//    touching a real filesystem.
// 3. FALSE POSITIVES ARE THE PRIMARY RISK, not false negatives. A guard that cries wolf gets
//    switched off, at which point its true-positive rate is zero. So: every check strips code
//    fences and inline-backtick spans first, requires same-sentence proximity rather than loose
//    character windows, and bails out on any hedging/future-tense/attempt language. Where a check
//    cannot be made precise with regex alone (see C2b), it is SOFT by design rather than being
//    tightened into something that merely *looks* rigorous.
//
// The hard/soft split maps directly onto enforcement (see orchestrator/loop.ts): hard findings
// force a self-correction turn, soft findings only raise a visible warning.
import { existsSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { ChecklistItem, FabricationFinding } from '@shared/types'
import { turnHasSubstantiveToolCall, type LedgerEntry, type PathTouch } from '../orchestrator/ledger'

export const CHECK_CODES = ['C1', 'C2a', 'C2b', 'C3', 'C4', 'C5', 'C6'] as const
export type CheckCode = (typeof CHECK_CODES)[number]

/** Which surface the message came from. Drives which checks run — see scopeForContext. */
export type DetectorContextKind = 'project-agent' | 'plan' | 'assistant' | 'subagent' | 'scheduled'

export interface DetectorInput {
  /** the message's free text (text blocks joined) */
  text: string
  /** the message's thinking blocks joined, if any */
  thinking?: string
  /** how many tool calls THIS message made (0 is what makes narration suspicious) */
  thisMessageToolCallCount: number
  /**
   * The turn ledger INCLUDING this message's own tool calls. Must be recomputed after streaming:
   * a pre-call snapshot would flag the first legitimate use of any tool in a turn, since the model
   * naturally says "I ran X" in the same message that calls X.
   */
  turnLedger: LedgerEntry[]
  /** session-wide write attempts, any status (see buildSessionWritePaths) */
  sessionWritePaths: PathTouch[]
  /** the same "now" that was injected into the model's trailing note */
  nowMs: number
  activeChecklist?: { title: string; items: ChecklistItem[] }
  /** root for resolving relative claimed paths. When absent, C3 is skipped entirely. */
  root?: string
  /**
   * Additional roots a bare/relative claimed path may legitimately refer to. C3 only flags a path
   * when it is missing under *every* root, because the agent routinely discusses real files that
   * live outside the workspace (its own settings.json, SOUL.md, memory notes). Resolving those
   * against the workspace alone produced a hard finding for a file that genuinely existed.
   */
  extraRoots?: string[]
  /** injected for testability; defaults to fs.existsSync */
  fileExists?: (absPath: string) => boolean
  /** tool names the detector should recognize in prose (C2b) */
  knownToolNames: readonly string[]
  contextKind: DetectorContextKind
}

export interface DetectionResult {
  hard: FabricationFinding[]
  soft: FabricationFinding[]
}

/**
 * Per-context check scoping. Running every check everywhere is the fastest route to the feature
 * being disabled:
 *  - Plan mode drops C3/C5/C6: a plan document is long prose that *describes files it intends to
 *    create* and walks through expected outputs, which would trip the artifact and narration
 *    checks on essentially every plan ever written.
 *  - Everything else runs the full suite; only the handling of hard findings differs by context
 *    (see loop.ts / runSubagent / scheduled tasks).
 */
export function scopeForContext(kind: DetectorContextKind): ReadonlySet<CheckCode> {
  if (kind === 'plan') return new Set<CheckCode>(['C1', 'C2a', 'C2b', 'C4'])
  return new Set<CheckCode>(CHECK_CODES)
}

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/**
 * Removes fenced code blocks and inline-backtick spans, replacing each with a single space.
 *
 * This is the single most important false-positive control in the module. Quoting a real earlier
 * tool result, pasting terminal output, and naming a tool in backticks are all extremely common
 * and entirely honest; none of them should be readable as a fresh claim. Replacing with a space
 * (rather than deleting) keeps sentence boundaries intact so the same-sentence proximity rules
 * below don't accidentally weld two unrelated sentences together.
 */
export function stripCodeSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;:])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Hedging, future-tense, and failed-attempt language. Presence anywhere in the sentence disables
 *  the claim-style checks for that sentence: "I will create X", "X would be generated", "I tried
 *  to write X but it was rejected" are all honest and must never be flagged. */
const HEDGE_RE =
  /\b(will|would|going to|plan to|plans to|should|could|might|may|if|once|when|after i|next|intend|intending|about to|plan|proposed|propose|plann(?:ed|ing)|plan's|tried|trying|attempt(?:ed|ing)?|reject(?:ed)?|denied|blocked|fail(?:ed|s|ure)?|couldn't|could not|cannot|can't|didn't|did not|don't|do not|won't|will not|instead of|rather than|no longer|unable|skipped|skipping|hypothetical|example|e\.g\.|placeholder|template|pseudo)\b/i

function excerptOf(s: string, max = 160): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

// ---------------------------------------------------------------------------
// C1 — clock guard
// ---------------------------------------------------------------------------

// Seconds are REQUIRED for the 24h form. This deliberately excludes bare `MM:SS`/`HH:MM`, because
// "22:03" in the incident was an elapsed *duration* ("22:03 total"), not a wall clock — matching it
// would flag every stopwatch-style figure an honest message reports.
const TIME_24H_RE = /\b([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)\b/g
const TIME_AMPM_RE = /\b(1[0-2]|0?[1-9]):([0-5]\d)(?::([0-5]\d))?\s*([ap])\.?m\.?\b/gi

/** Completion framing. Note the absence of `total`/`elapsed`/`took`: those accompany durations, not
 *  wall-clock instants, and including them was the main false-positive source in review. */
const COMPLETION_CUE_RE = /\b(finish(?:ed)?|complet(?:e|ed)|done|ended|wrapped up|shipped|final(?:ized)?)\b/i
/** The timestamp must be framed as an instant ("at 14:22:05"), not a span ("in 1:02:03"). */
const AT_FRAMING_RE = /\b(at|by|as of|timestamp|on the clock)\s*$/i
const DURATION_FRAMING_RE = /\b(total|elapsed|took|duration|runtime|in|after|within|over|under|about|~)\s*$/i

const CLOCK_TOLERANCE_MS = 60_000
/** If a claimed wall-clock lands more than this far ahead, assume it refers to the previous day
 *  (e.g. now = 00:05, claim = 23:50) rather than being a future claim. */
const CLOCK_WRAP_GUARD_MS = 12 * 60 * 60 * 1000

function checkClock(input: DetectorInput, stripped: string, out: FabricationFinding[]): void {
  const now = new Date(input.nowMs)
  for (const sentence of splitSentences(stripped)) {
    if (!COMPLETION_CUE_RE.test(sentence)) continue

    const candidates: { h: number; m: number; s: number; idx: number; raw: string }[] = []
    for (const m of sentence.matchAll(TIME_24H_RE)) {
      candidates.push({ h: Number(m[1]), m: Number(m[2]), s: Number(m[3]), idx: m.index ?? 0, raw: m[0] })
    }
    for (const m of sentence.matchAll(TIME_AMPM_RE)) {
      let h = Number(m[1]) % 12
      if (m[4].toLowerCase() === 'p') h += 12
      candidates.push({ h, m: Number(m[2]), s: Number(m[3] ?? 0), idx: m.index ?? 0, raw: m[0] })
    }

    for (const c of candidates) {
      const before = sentence.slice(Math.max(0, c.idx - 24), c.idx)
      // A span ("in 1:02:03", "total 0:00:03") is not a completion instant.
      if (DURATION_FRAMING_RE.test(before)) continue
      // Require explicit instant framing so a bare number in a completion sentence isn't enough.
      if (!AT_FRAMING_RE.test(before)) continue

      const claimed = new Date(now)
      claimed.setHours(c.h, c.m, c.s, 0)
      const delta = claimed.getTime() - input.nowMs
      if (delta <= CLOCK_TOLERANCE_MS) continue
      if (delta > CLOCK_WRAP_GUARD_MS) continue // almost certainly yesterday, not the future

      out.push({
        code: 'C1',
        severity: 'hard',
        detail: `Claimed a completion time of ${c.raw}, which is ${Math.round(delta / 1000)}s in the future relative to the real current time (${now.toTimeString().slice(0, 8)}). Work cannot have finished at a time that has not happened yet.`,
        excerpt: excerptOf(sentence)
      })
      return // one clock finding per message is enough
    }
  }
}

// ---------------------------------------------------------------------------
// C2a — literal fabricated tool-call marker
// ---------------------------------------------------------------------------

// The transcript renderer (compaction/compactor.ts) uses "[called toolName(args)]" as the ONE
// unforgeable signal that a call really happened, and sanitizes the pattern out of free text so a
// fabricated copy can't masquerade as a real one. That sanitization prevents the *poisoning*, but
// nothing until now actually *reported* the attempt. This does.
const LITERAL_MARKER_RE = /\[called\s+([a-z_][a-z0-9_]{2,40})\s*\(/i

function checkLiteralMarker(stripped: string, out: FabricationFinding[]): void {
  const m = LITERAL_MARKER_RE.exec(stripped)
  if (!m) return
  out.push({
    code: 'C2a',
    severity: 'hard',
    detail: `Message contains fabricated tool-call marker syntax ("[called ${m[1]}(…)") written as prose. That syntax is generated only by the harness for calls that genuinely executed; writing it by hand is an attempt to make an uncalled tool look called.`,
    excerpt: excerptOf(m[0])
  })
}

// ---------------------------------------------------------------------------
// C2b — prose tool claim (SOFT)
// ---------------------------------------------------------------------------

// Kept deliberately narrow and SOFT. Regex cannot reliably separate "I called read_file" (a claim)
// from "the read_file tool takes a path" (a discussion) — and in this very repo, ordinary messages
// name tools constantly. So: first-person + completed verb + immediately-adjacent tool name only,
// and because stripCodeSpans() has already removed backticked mentions, the common
// discussing-a-tool phrasing never even reaches this check.
const FIRST_PERSON_CALL_RE =
  /\bI\s+(?:just\s+|already\s+|then\s+)?(called|ran|invoked|executed)\s+(?:the\s+)?([a-z_][a-z0-9_]{2,40})\b/gi

function checkProseToolClaim(input: DetectorInput, stripped: string, out: FabricationFinding[]): void {
  const known = new Set(input.knownToolNames)
  const actuallyCalled = new Set(input.turnLedger.map((e) => e.toolName))
  const reported = new Set<string>()

  for (const sentence of splitSentences(stripped)) {
    if (HEDGE_RE.test(sentence)) continue
    for (const m of sentence.matchAll(FIRST_PERSON_CALL_RE)) {
      const name = m[2].toLowerCase()
      if (!known.has(name) || actuallyCalled.has(name) || reported.has(name)) continue
      reported.add(name)
      out.push({
        code: 'C2b',
        severity: 'soft',
        detail: `Message states it ${m[1]} "${name}", but no ${name} call appears in this turn's verification ledger.`,
        excerpt: excerptOf(sentence)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// C3 — artifact existence
// ---------------------------------------------------------------------------

// Cheap prefilter only: presence of a creation-ish verb anywhere in the sentence. Authorship is
// decided by the three regexes below, not by this one.
const CREATION_CUE_RE = /\b(created|create|wrote|written|writing|added|generated|scaffolded|saved|produced|emitted|output)\b/i

/**
 * A creation verb on its own is NOT a claim of authorship, and C3's entire premise is "this message
 * says *it* brought a file into being". So the verb must attach to a first-person subject ("I
 * created X", "we wrote X") or open an elided-subject clause ("Created X", "- Wrote X").
 *
 * Real false positive this fixes: prose describing a file's *mtime* —
 * `settings.json (written 14:22, before the update)` — which reports someone else's past write and
 * asserts nothing about this message having performed it. That was flagged as a hard finding.
 */
const AUTHORSHIP_CUE_RE =
  /\b(?:i|we)\b(?:\s+\w+){0,3}?\s+(?:created|wrote|added|generated|scaffolded|saved|produced|emitted)\b/i
const ELIDED_AUTHORSHIP_RE =
  /(?:^|[.;:!?]\s+|^\s*[-*+]\s*)(?:created|wrote|added|generated|scaffolded|saved|produced)\b/i
/** Passive, attributive, or metadata framing — something/someone else did it, or the sentence is
 *  merely reporting a timestamp. Any match bails the sentence out of C3 entirely. Under-flagging is
 *  the correct failure mode for a hard-tier check. */
const NON_AUTHORSHIP_RE =
  /\b(?:was|were|is|are|be|been|being|got|gets)\s+(?:just\s+|already\s+|previously\s+|recently\s+|last\s+)?(?:created|written|added|generated|scaffolded|saved|produced|modified)\b|\b(?:created|written|added|generated|saved|modified)\s+(?:by|on|at)\s|\b(?:created|written|modified|saved|added)\s+\d|\b(?:mtime|ctime|last\s+modified|last\s+written|timestamp)\b/i
// Requires a real-looking extension (1-8 chars) or a trailing slash for directories.
// NOTE: the extension class allows digits, so this alone also matches decimals like `78.70` and
// `5.1.2`. looksLikeRealPath() below is what rejects those — see its comment.
const PATH_TOKEN_RE = /(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@-]+[\\/])*[\w.@-]+(?:\.[A-Za-z0-9]{1,8}|[\\/])(?=$|[\s,;:!?)"'\]]|\.\s)/g
const SYSTEM_PATH_RE = /^(?:[\\/](?:etc|usr|bin|sbin|proc|sys|dev|var|opt|tmp|lib)\b|[A-Za-z]:[\\/](?:windows|program files))/i
const URL_RE = /^(?:https?:|ftp:|mailto:|data:)/i
const MAX_PATHS_CHECKED = 12

const HAS_LETTER_RE = /[A-Za-z]/

/**
 * Rejects number-shaped tokens that PATH_TOKEN_RE matches only incidentally.
 *
 * Real false positive this fixes: a currency amount in a results table (`$78.70 saved`) was read as
 * a file named `78.70` with extension `70`, producing a hard finding against a figure that came
 * straight out of a session file's `cacheSavingsUsd`. Version strings (`5.1.2`), sub-second
 * durations (`1.29`) and percentages have the same shape.
 *
 * Rule: a filename must carry at least one letter, and — for an extension-bearing token — the
 * extension itself must too. No real extension is all-digits, while every all-digit "extension" is
 * a decimal fraction. Slash-bearing tokens only need a letter somewhere (`123/456/` is conceivable
 * but vanishingly rare, and under-flagging is the correct failure mode for a hard-tier check).
 */
function looksLikeRealPath(claimed: string): boolean {
  if (!HAS_LETTER_RE.test(claimed)) return false
  if (/[\\/]/.test(claimed)) return true
  const lastDot = claimed.lastIndexOf('.')
  if (lastDot < 0) return true
  return HAS_LETTER_RE.test(claimed.slice(lastDot + 1))
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

function basenameOf(p: string): string {
  const n = normalizePath(p).replace(/\/+$/, '')
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(i + 1) : n
}

/** Generous on purpose: any plausible correspondence between a claimed path and a real write
 *  attempt suppresses the finding. Under-flagging is the correct failure mode here. */
function wasWriteAttempted(claimed: string, touches: PathTouch[]): boolean {
  const c = normalizePath(claimed).replace(/\/+$/, '')
  const cBase = basenameOf(claimed)
  return touches.some((t) => {
    const p = normalizePath(t.path).replace(/\/+$/, '')
    return p === c || p.endsWith(`/${c}`) || c.endsWith(`/${p}`) || basenameOf(t.path) === cBase
  })
}

function checkArtifacts(input: DetectorInput, stripped: string, out: FabricationFinding[]): void {
  const root = input.root
  if (!root) return
  const roots = [root, ...(input.extraRoots ?? [])].filter((r): r is string => Boolean(r))
  const exists = input.fileExists ?? ((p: string) => existsSync(p))
  let checked = 0

  for (const sentence of splitSentences(stripped)) {
    if (checked >= MAX_PATHS_CHECKED) break
    if (!CREATION_CUE_RE.test(sentence)) continue
    // "I would create src/x.ts", "I tried to write X but it was rejected" — honest either way.
    if (HEDGE_RE.test(sentence)) continue
    // "X was generated by the build", "settings.json (written 14:22)" — reports someone else's
    // write or a bare mtime, not an authorship claim by this message.
    if (NON_AUTHORSHIP_RE.test(sentence)) continue
    if (!AUTHORSHIP_CUE_RE.test(sentence) && !ELIDED_AUTHORSHIP_RE.test(sentence)) continue

    for (const m of sentence.matchAll(PATH_TOKEN_RE)) {
      if (checked >= MAX_PATHS_CHECKED) break
      const claimed = m[0]
      if (URL_RE.test(claimed) || SYSTEM_PATH_RE.test(claimed)) continue
      // Bare sentence-ending words like "done." can slip through the extension rule.
      if (!/[\\/]/.test(claimed) && !/\.[A-Za-z0-9]{1,8}$/.test(claimed)) continue
      // Money amounts, version strings, durations, percentages — numbers, not files.
      if (!looksLikeRealPath(claimed)) continue
      if (wasWriteAttempted(claimed, input.sessionWritePaths)) continue

      checked++
      // A relative path is checked under every plausible root; only a path missing from all of
      // them counts as unsupported.
      const candidates = isAbsolute(claimed) ? [claimed] : roots.map((r) => resolvePath(r, claimed))
      if (candidates.some((c) => exists(c))) continue

      out.push({
        code: 'C3',
        severity: 'hard',
        detail: `Message describes creating/writing "${claimed}", but no write tool ever targeted that path in this session and it does not exist on disk (checked ${candidates.slice(0, 4).join(', ')}).`,
        excerpt: excerptOf(sentence)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// C4 — checklist contradiction
// ---------------------------------------------------------------------------

const WHOLESALE_COMPLETION_RES: RegExp[] = [
  /\ball\s+\d+\s+(?:items?|steps?|phases?)\b/i,
  /\b(\d+)\s*(?:of|\/)\s*(\d+)\s+(?:items?|steps?)?\s*(?:are\s+)?(?:now\s+)?(?:done|complete|completed|finished)\b/i,
  /\bchecklist\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|done|fully\s+done)\b/i,
  /\ball\s+(?:the\s+)?items?\s+(?:are\s+)?(?:now\s+)?(?:done|complete|completed|checked off)\b/i,
  /\bevery\s+(?:item|step|phase)\b[^.]{0,40}\b(?:done|complete|completed)\b/i,
  /\ball\s+(?:items?|steps?|phases?)\s+(?:checked off|ticked off)\b/i
]

function assertsWholesaleCompletion(stripped: string): string | undefined {
  for (const sentence of splitSentences(stripped)) {
    if (HEDGE_RE.test(sentence)) continue
    if (WHOLESALE_COMPLETION_RES.some((re) => re.test(sentence))) return sentence
  }
  return undefined
}

function checkChecklistContradiction(input: DetectorInput, stripped: string, out: FabricationFinding[]): void {
  const cl = input.activeChecklist
  if (!cl || cl.items.length === 0) return
  const undone = cl.items.filter((it) => !it.done)
  const calledUpdate = input.turnLedger.some((e) => e.toolName === 'update_checklist')

  // Case A — claims completion while the live checklist plainly disagrees. Skipped when
  // update_checklist actually ran this turn: the claim is then at least wired to the real
  // mechanism, and Case B below is the check that applies instead.
  if (undone.length > 0) {
    if (calledUpdate) return
    const sentence = assertsWholesaleCompletion(stripped)
    if (!sentence) return
    out.push({
      code: 'C4',
      severity: 'hard',
      detail: `Message asserts the checklist is complete, but the live checklist still has ${undone.length} unfinished item(s) (${undone.map((u) => `"${u.text}"`).slice(0, 3).join(', ')}) and no update_checklist call was made this turn.`,
      excerpt: excerptOf(sentence)
    })
    return
  }

  // Case B — the plan's escalation clause: the checklist reads fully complete, but it only got
  // there via update_checklist calls made in a turn that did no real work. That is the CoFrame
  // incident's exact shape (nine items "completed", zero substantive calls).
  //
  // All three conditions are required to avoid the obvious false positive: a later, honest
  // "yes, everything's done" recap turn. Such a turn makes no update_checklist call, so
  // `calledUpdate` is false and this never fires on stale tags from previous turns.
  if (!calledUpdate) return
  if (turnHasSubstantiveToolCall(input.turnLedger)) return
  const unbacked = cl.items.filter((it) => it.evidenceQuality === 'unverified-no-tool-calls')
  if (unbacked.length === 0) return
  const sentence = assertsWholesaleCompletion(stripped)
  if (!sentence) return
  out.push({
    code: 'C4',
    severity: 'hard',
    detail: `Message asserts the whole checklist is complete, but ${unbacked.length} item(s) were marked done in this turn without a single substantive tool call to back them (${unbacked.map((u) => `"${u.text}"`).slice(0, 3).join(', ')}). Marking an item done is not evidence that the work happened.`,
    excerpt: excerptOf(sentence)
  })
}

// ---------------------------------------------------------------------------
// C5 / C6 — narration volume heuristics (SOFT)
// ---------------------------------------------------------------------------

/** Patterns that read as *reported command output* rather than discussion. Code fences are already
 *  stripped, so a message that legitimately quotes real output in a block scores zero here. */
const RESULT_SIGNAL_RES: RegExp[] = [
  /\bexit\s+code\s+\d+/i,
  /^\s*\$\s+\S+/m,
  /\b\d+\s+passed\b/i,
  /\b\d+\s+(?:tests?|specs?)\s+(?:passed|ok|green)\b/i,
  /\bHTTP\/\d(?:\.\d)?\b/,
  /\b[1-5]\d{2}\s+(?:OK|Created|No Content|Accepted|Not Found|Bad Request)\b/,
  /\b\d+\.\d+\s?s(?:ec|econds)?\b/i,
  /\breal\s+\d+m\d/i,
  /\b\d+\s+(?:rows?|records?|files?)\s+(?:affected|written|created|migrated)\b/i,
  /\bOK\s*\(\d+\s+tests?\)/i
]

const SOFT_RATIO_THRESHOLD = 6
const SOFT_RATIO_THRESHOLD_WITH_BULK = 3
const BULK_TEXT_CHARS = 8000

function checkNarrationVolume(
  input: DetectorInput,
  stripped: string,
  enabled: ReadonlySet<CheckCode>,
  out: FabricationFinding[]
): void {
  if (input.thisMessageToolCallCount > 0) return

  const isBulk = stripped.length > BULK_TEXT_CHARS
  if (enabled.has('C6') && isBulk) {
    out.push({
      code: 'C6',
      severity: 'soft',
      detail: `Message is ${stripped.length} characters of prose and made no tool calls at all. Long result-describing messages with no execution behind them are the shape of the fabricated-build failure mode.`
    })
  }

  if (!enabled.has('C5')) return
  const signals = RESULT_SIGNAL_RES.reduce((n, re) => n + (re.test(stripped) ? 1 : 0), 0)
  const threshold = isBulk ? SOFT_RATIO_THRESHOLD_WITH_BULK : SOFT_RATIO_THRESHOLD
  if (signals < threshold) return
  out.push({
    code: 'C5',
    severity: 'soft',
    detail: `Message reports ${signals} distinct command-result signals (exit codes, test counts, HTTP statuses, timings) but made no tool calls, and the ledger shows ${input.turnLedger.length} call(s) this turn.`
  })
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function detectFabrication(input: DetectorInput): DetectionResult {
  const enabled = scopeForContext(input.contextKind)
  const hard: FabricationFinding[] = []
  const soft: FabricationFinding[] = []

  // Thinking is included for the marker check only: a fabricated marker in reasoning is just as
  // poisonous to compaction as one in user-visible text. The claim-style checks stay on visible
  // text, since thinking is explicitly a scratchpad where the model reasons about hypotheticals.
  const strippedText = stripCodeSpans(input.text ?? '')
  const strippedThinking = stripCodeSpans(input.thinking ?? '')

  if (enabled.has('C1')) checkClock(input, strippedText, hard)
  if (enabled.has('C2a')) {
    checkLiteralMarker(strippedText, hard)
    if (hard.every((f) => f.code !== 'C2a')) checkLiteralMarker(strippedThinking, hard)
  }
  if (enabled.has('C3')) checkArtifacts(input, strippedText, hard)
  if (enabled.has('C4')) checkChecklistContradiction(input, strippedText, hard)
  if (enabled.has('C2b')) checkProseToolClaim(input, strippedText, soft)
  checkNarrationVolume(input, strippedText, enabled, soft)

  return { hard, soft }
}

/**
 * The machine-written audit note injected back into the conversation after hard findings, and the
 * body of the warning appended to subagent/scheduled-task output.
 *
 * Written as a flat statement of what the harness observed plus an explicit menu of acceptable
 * responses. It deliberately does NOT tell the model to apologize or re-narrate: the failure mode
 * being corrected is *producing convincing prose in place of work*, so the remedy has to be either
 * real tool calls or a plain admission.
 */
export function buildAuditNote(findings: FabricationFinding[], ledgerDigest: string): string {
  const lines = findings.map((f, i) => `${i + 1}. [${f.code}] ${f.detail}${f.excerpt ? `\n   Your words: "${f.excerpt}"` : ''}`)
  return [
    'AUTOMATED VERIFICATION NOTICE (generated by the harness, not by the user).',
    '',
    'Your previous message made claims that contradict the harness\'s own execution records:',
    '',
    lines.join('\n'),
    '',
    ledgerDigest,
    '',
    'Do exactly one of the following in your next message, and nothing else:',
    '  (a) If the work genuinely has not been done: say so plainly, retract the unsupported claims, and then actually do it with real tool calls.',
    '  (b) If you believe the work WAS done: cite the specific ledger entries above that back each claim. If you cannot point to one, treat the claim as unsupported and go to (a).',
    '',
    'Do not repeat the unsupported claims, do not pad this with apology, and do not describe any further action you have not actually taken. Reporting that something is not done is a fully acceptable outcome; inventing a success is not.'
  ].join('\n')
}
