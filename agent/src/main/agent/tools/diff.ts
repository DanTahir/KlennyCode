import { createTwoFilesPatch } from 'diff'

// ---------- Safety limits ----------
//
// These exist because of a real incident: the agent called delete_file on a ~20 MB binary
// `.mov` capture. `readFile(abs, 'utf8')` happily decoded it to mojibake, makeDiff produced a
// 20 MB unified diff of that mojibake, and the diff was stored in the tool result -> persisted
// into the workspace session JSON. That file grew to 61 MB, which (a) froze the app on its
// loading screen, (b) froze external text editors opening the log, and (c) made a sibling
// delete_file call die with "Maximum call stack size exceeded" inside jsdiff.
//
// A diff is a *human-readable preview*. Past a few thousand lines nobody reads it, so clamping
// costs nothing real while removing an unbounded-growth path through every persisted session.

/** Per-side input cap. Above this we don't even attempt a diff. */
export const MAX_DIFF_INPUT_CHARS = 1_000_000
/** Cap for one file's diff. */
export const MAX_DIFF_OUTPUT_CHARS = 100_000
/** Cap for one file's diff, in lines (a diff can be small in chars but huge in line count). */
export const MAX_DIFF_OUTPUT_LINES = 2_000
/** Per-line cap — a minified bundle is only "2 lines" but megabytes wide. */
export const MAX_DIFF_LINE_CHARS = 2_000
/** Cap for a combined multi-file diff (multi_edit/multi_write). */
export const MAX_COMBINED_DIFF_CHARS = 400_000

/** How much of a string to sample when sniffing for binary content. */
const BINARY_SNIFF_CHARS = 8_192
/** Fraction of control characters above which a sample is considered binary. */
const BINARY_CONTROL_RATIO = 0.02

function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M chars`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K chars`
  return `${n} chars`
}

/** True if `text` looks like decoded binary rather than source/prose.
 *
 *  Reading a binary file with encoding 'utf8' never fails — it yields U+FFFD replacement
 *  characters and raw control bytes — so "did the read throw" is NOT a usable binary check.
 *  Sniffing the decoded string is. NUL and U+FFFD are decisive on their own; otherwise we look
 *  at the density of control characters (tab/LF/CR excluded, since those are normal text). */
export function looksBinary(text: string): boolean {
  if (text.length === 0) return false
  const sample = text.length > BINARY_SNIFF_CHARS ? text.slice(0, BINARY_SNIFF_CHARS) : text
  if (sample.includes('\u0000') || sample.includes('\uFFFD')) return true
  let control = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 9 || c === 10 || c === 13) continue
    if (c < 32 || c === 127) control++
  }
  return control / sample.length > BINARY_CONTROL_RATIO
}

/** A stand-in "diff" explaining why no diff is shown. Deliberately keeps the `--- `/`+++ `
 *  header shape so the UI's DiffViewer still renders it as a recognizable diff card, and so
 *  callers never have to special-case an empty/undefined diff. */
export function diffOmitted(path: string, reason: string): string {
  return [`--- a/${path}`, `+++ b/${path}`, '@@ diff omitted @@', ` ${reason}`].join('\n')
}

/** Clamps a generated diff to the output limits above, reporting what was dropped *in band*
 *  (a silently-sliced diff is indistinguishable from a genuinely small change). */
function clampDiff(diff: string): string {
  const lines = diff.split('\n')
  const withinLines = lines.length <= MAX_DIFF_OUTPUT_LINES
  if (withinLines && diff.length <= MAX_DIFF_OUTPUT_CHARS && !lines.some((l) => l.length > MAX_DIFF_LINE_CHARS)) {
    return diff
  }
  const kept: string[] = []
  let chars = 0
  let i = 0
  for (; i < lines.length; i++) {
    if (kept.length >= MAX_DIFF_OUTPUT_LINES || chars >= MAX_DIFF_OUTPUT_CHARS) break
    const raw = lines[i]
    const line =
      raw.length > MAX_DIFF_LINE_CHARS
        ? `${raw.slice(0, MAX_DIFF_LINE_CHARS)} …[line truncated, ${raw.length - MAX_DIFF_LINE_CHARS} more chars]`
        : raw
    kept.push(line)
    chars += line.length + 1
  }
  const omitted = lines.length - i
  if (omitted > 0) kept.push(`@@ ${omitted} more diff line${omitted === 1 ? '' : 's'} omitted (diff truncated for display) @@`)
  return kept.join('\n')
}

// Produces a real unified diff (proper LCS-based line alignment + hunk headers with
// surrounding context), instead of a naive index-by-index comparison. A naive comparison
// misaligns every line after the first insertion/deletion, making the whole rest of the
// file look changed — this is what made earlier diffs unreadable.
//
// Total by contract: never throws, and never returns more than ~MAX_DIFF_OUTPUT_CHARS. Callers
// embed the result in tool results that get persisted to the session log and shipped over IPC,
// so an unbounded return value here corrupts those artifacts (see the incident note above).
export function makeDiff(oldText: string, newText: string, path: string): string {
  const oldStr = typeof oldText === 'string' ? oldText : String(oldText ?? '')
  const newStr = typeof newText === 'string' ? newText : String(newText ?? '')

  if (looksBinary(oldStr) || looksBinary(newStr)) {
    return diffOmitted(path, `binary file (${formatChars(Math.max(oldStr.length, newStr.length))}) — diff omitted`)
  }
  if (oldStr.length > MAX_DIFF_INPUT_CHARS || newStr.length > MAX_DIFF_INPUT_CHARS) {
    const size = formatChars(Math.max(oldStr.length, newStr.length))
    return diffOmitted(path, `file too large to diff (${size}, limit ${formatChars(MAX_DIFF_INPUT_CHARS)}) — diff omitted`)
  }

  let patch: string
  try {
    patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldStr, newStr, '', '', { context: 3 })
  } catch (e) {
    // jsdiff is recursive and can blow the stack ("Maximum call stack size exceeded") on
    // pathological inputs. A failed preview must never fail the mutation that owns it.
    return diffOmitted(path, `diff could not be generated (${e instanceof Error ? e.message : String(e)})`)
  }

  // createTwoFilesPatch's first two lines are the `Index:` / `===...` banner lines produced
  // by the underlying `structuredPatch`/`formatPatch` helpers; we only want the `--- `/`+++ `
  // header and hunks that follow, matching the format the UI's DiffViewer expects. The
  // `--- `/`+++ ` header lines also get a trailing tab appended by jsdiff when the (unused)
  // timestamp argument is an empty string, which we trim for a cleaner header.
  const lines = patch.split('\n')
  const headerStart = lines.findIndex((l) => l.startsWith('--- '))
  const body = headerStart >= 0 ? lines.slice(headerStart) : lines
  const cleaned = body.map((l) => (l.startsWith('--- ') || l.startsWith('+++ ') ? l.replace(/\t$/, '') : l)).join('\n')
  return clampDiff(cleaned)
}

/** Concatenates per-file diffs for a batch tool (multi_edit/multi_write) under a combined cap.
 *  Each individual diff is already clamped by makeDiff, but 200 files x 100K would still be
 *  20 MB — the exact shape that poisoned a session log. Reports the shortfall in band. */
export function joinDiffs(diffs: string[]): string {
  const parts: string[] = []
  let chars = 0
  for (let i = 0; i < diffs.length; i++) {
    const d = diffs[i]
    if (!d) continue
    if (chars + d.length > MAX_COMBINED_DIFF_CHARS) {
      const remaining = diffs.length - i
      parts.push(`@@ ${remaining} more file diff${remaining === 1 ? '' : 's'} omitted (combined diff size limit reached) @@`)
      break
    }
    parts.push(d)
    chars += d.length + 1
  }
  return parts.join('\n')
}
