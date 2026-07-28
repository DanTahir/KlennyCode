import { readFile, writeFile, unlink, stat, mkdir } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'
import type { ToolResultPayload } from '@shared/types'
import { buildEditNotFoundHelp, countOccurrences, resolveEditMatch } from './edit-match'
import { detectEol, fromLf, toLf, type Eol } from './eol'
import { makeDiff } from './diff'
import { assertInWorkspace, getWorkspace, isInsideDirectory } from '../../workspace'

// `content` in this cache is always normalized to LF, regardless of the file's on-disk
// EOL style or the machine's `core.autocrlf` setting — see ./eol.ts. This keeps matching,
// line numbering, and diffing consistent no matter how the file (or model output) is
// line-ended; the original EOL style is restored when writing back to disk.
const fileReadCache = new Map<string, { mtimeMs: number; content: string }>()

/** `root`, when given, overrides the open-project workspace as the base a relative path
 *  resolves against and (for mutations, via `assertInRoot` below) the sandbox boundary. Used
 *  for Assistant-tab calls, which pass AppSettings.documentsDirectory (resolved once by the
 *  caller — see documentsDir.ts) since Assistant tabs have no project workspace of their own.
 *  Omitted (the default), this behaves exactly as before: relative paths resolve against
 *  getWorkspace()'s process-global singleton. */
export function resolveWorkspacePath(relOrAbs: string, root?: string): string {
  if (typeof relOrAbs !== 'string' || relOrAbs.length === 0) {
    // Guards against a malformed tool call (e.g. a batch edit missing/nulling `path`) crashing
    // with a raw TypeError from node:path — throw a clean, catchable Error instead so callers
    // (multi_edit's preview + real run in particular) can turn it into a normal tool error
    // rather than an unhandled exception that kills the whole agent turn.
    throw new Error(`Invalid path: expected a non-empty string, got ${JSON.stringify(relOrAbs)}`)
  }
  if (isAbsolute(relOrAbs)) return resolve(relOrAbs)
  const base = root ?? getWorkspace()
  if (!base) throw new Error('No workspace open. Pass an absolute path to reach a file outside a workspace.')
  return resolve(base, relOrAbs)
}

/** Sandbox check for a mutation's resolved absolute path: against `root` when given (Assistant
 *  tabs, scoped to documentsDirectory), otherwise falls back to the open-project workspace via
 *  assertInWorkspace, exactly like before `root` existed. */
function assertInRoot(abs: string, root?: string): boolean {
  return root ? isInsideDirectory(abs, root) : assertInWorkspace(abs)
}

// read_file (and grep/glob, see search.ts) are deliberately NOT sandboxed for absolute paths —
// per user request, they're global, read-only tools that can see anything the OS user running
// Klenny can see (any absolute path on the host, or a path relative to `root`/the open
// workspace). write_file/edit_file/multi_edit/delete_file remain sandboxed to `root`/the
// workspace (see assertInRoot above) since mutation is the operation that actually needs the
// safety rail.
export async function readFileTool(
  args: { path: string; offset?: number; limit?: number },
  root?: string
): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  const raw = await readFile(abs, 'utf8')
  const content = toLf(raw)
  const st = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st.mtimeMs, content })
  const lines = content.split('\n')
  const offset = Math.max(1, args.offset ?? 1)
  const limit = args.limit ?? lines.length
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((l, i) => `${offset + i}|${l}`).join('\n')
  return { ok: true, summary: `Read ${args.path} (${slice.length} lines)`, data: { path: args.path, content: numbered } }
}

export async function writeFileTool(args: { path: string; content: string }, root?: string): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  if (!assertInRoot(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  let oldRaw = ''
  let hadExisting = false
  try {
    oldRaw = await readFile(abs, 'utf8')
    hadExisting = true
  } catch {
    // new file
  }
  // Preserve the existing file's EOL convention (default to LF for new files) so we don't
  // rewrite an entire CRLF file to LF (or vice versa) just because the model's content
  // string happens to use a different style. Model output is normalized to LF first.
  const eol = hadExisting ? detectEol(oldRaw) : '\n'
  const normalized = toLf(args.content)
  const finalContent = fromLf(normalized, eol)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, finalContent, 'utf8')
  const st = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st.mtimeMs, content: normalized })
  return {
    ok: true,
    summary: `Wrote ${args.path}`,
    data: { path: args.path, diff: makeDiff(toLf(oldRaw), normalized, args.path) }
  }
}

export async function editFileTool(
  args: {
    path: string
    old_string: string
    new_string: string
    replace_all?: boolean
  },
  root?: string
): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  if (!assertInRoot(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const raw = await readFile(abs, 'utf8')
  const eol = detectEol(raw)
  const content = toLf(raw)
  const cached = fileReadCache.get(abs)
  const st = await stat(abs)
  if (cached && cached.mtimeMs !== st.mtimeMs) {
    return {
      ok: false,
      summary: 'File changed on disk since last read',
      error: 'stale',
      data: { path: args.path, hint: 'Call read_file again, then retry edit_file with the exact text shown.' }
    }
  }

  const match = resolveEditMatch(content, args.old_string, args.new_string)
  if (!match) {
    return {
      ok: false,
      summary: 'old_string not found',
      error: 'not_found',
      data: { path: args.path, ...buildEditNotFoundHelp(content, args.old_string) }
    }
  }

  const count = countOccurrences(content, match.oldString)
  if (!args.replace_all && count > 1) {
    return {
      ok: false,
      summary: `old_string appears ${count} times; use replace_all or provide more context`,
      error: 'ambiguous',
      data: { path: args.path, occurrences: count }
    }
  }
  const next = args.replace_all
    ? content.replaceAll(match.oldString, match.newString)
    : content.replace(match.oldString, match.newString)
  // Write back using the file's original EOL style so we don't churn the whole file's
  // line endings on a small edit (which would happen if we always wrote LF-only, and
  // would produce a noisy diff/unwanted git changes when core.autocrlf converts on checkout).
  await writeFile(abs, fromLf(next, eol), 'utf8')
  const st2 = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st2.mtimeMs, content: next })
  return {
    ok: true,
    summary: args.replace_all ? `Edited ${args.path} (${count} replacements)` : `Edited ${args.path}`,
    data: { path: args.path, diff: makeDiff(content, next, args.path), replacements: count }
  }
}

export interface MultiEditOp {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}

interface PlannedFileEdit {
  path: string
  abs: string
  eol: Eol
  oldContent: string
  newContent: string
  editCount: number
}

interface PlanMultiEditError {
  ok: false
  index: number
  path: string
  summary: string
  error: string
  data?: Record<string, unknown>
}

/** Shared by multiEditFileTool (real run) and the approval preview (dry run): applies every
 *  edit in `edits`, in order, against in-memory content grouped by file — so edits targeting
 *  the same file compose (edit #2's old_string can match text produced by edit #1) exactly like
 *  calling edit_file repeatedly would, but validated as one all-or-nothing batch before any
 *  file is written. Returns either the per-file plan (nothing written yet) or the first failure
 *  encountered, with enough context to report which edit/file it was.
 */
async function planMultiEdit(
  edits: MultiEditOp[],
  checkStale: boolean,
  root?: string
): Promise<{ ok: true; files: PlannedFileEdit[] } | PlanMultiEditError> {
  const files = new Map<string, PlannedFileEdit>()

  for (let i = 0; i < edits.length; i++) {
    const op = edits[i]
    // Defensive validation: a malformed batch entry (missing/wrong-typed field — seen from
    // models that occasionally drop `path` on a repeated edit to the same file, or send
    // `edits` double-encoded as a JSON string) must not crash the whole tool call. Report it
    // as a normal not-ok result the model can see and correct, instead of letting
    // resolveWorkspacePath/String methods throw a raw, uncaught TypeError further down.
    if (
      !op ||
      typeof op !== 'object' ||
      typeof op.path !== 'string' ||
      op.path.length === 0 ||
      typeof op.old_string !== 'string' ||
      typeof op.new_string !== 'string'
    ) {
      return {
        ok: false,
        index: i,
        path: typeof op?.path === 'string' ? op.path : '',
        summary: `Malformed edit at index ${i}: each entry needs string "path", "old_string", and "new_string" fields`,
        error: 'invalid_edit'
      }
    }

    const abs = resolveWorkspacePath(op.path, root)
    if (!assertInRoot(abs, root)) {
      return { ok: false, index: i, path: op.path, summary: 'Path outside workspace', error: 'sandbox' }
    }

    let planned = files.get(abs)
    if (!planned) {
      let raw: string
      try {
        raw = await readFile(abs, 'utf8')
      } catch {
        return { ok: false, index: i, path: op.path, summary: `File not found: ${op.path}`, error: 'not_found' }
      }
      if (checkStale) {
        const cached = fileReadCache.get(abs)
        const st = await stat(abs)
        if (cached && cached.mtimeMs !== st.mtimeMs) {
          return {
            ok: false,
            index: i,
            path: op.path,
            summary: 'File changed on disk since last read',
            error: 'stale',
            data: { path: op.path, hint: 'Call read_file again, then retry multi_edit with the exact text shown.' }
          }
        }
      }
      const eol = detectEol(raw)
      const content = toLf(raw)
      planned = { path: op.path, abs, eol, oldContent: content, newContent: content, editCount: 0 }
      files.set(abs, planned)
    }

    const match = resolveEditMatch(planned.newContent, op.old_string, op.new_string)
    if (!match) {
      return {
        ok: false,
        index: i,
        path: op.path,
        summary: `old_string not found (edit ${i + 1} of ${edits.length}, ${op.path})`,
        error: 'not_found',
        data: { path: op.path, ...buildEditNotFoundHelp(planned.newContent, op.old_string) }
      }
    }

    const count = countOccurrences(planned.newContent, match.oldString)
    if (!op.replace_all && count > 1) {
      return {
        ok: false,
        index: i,
        path: op.path,
        summary: `old_string appears ${count} times in edit ${i + 1} of ${edits.length} (${op.path}); use replace_all or provide more context`,
        error: 'ambiguous',
        data: { path: op.path, occurrences: count }
      }
    }

    planned.newContent = op.replace_all
      ? planned.newContent.replaceAll(match.oldString, match.newString)
      : planned.newContent.replace(match.oldString, match.newString)
    planned.editCount++
  }

  return { ok: true, files: [...files.values()] }
}

/** `edits` should always arrive as a real array per the tool schema, but some models/providers
 *  double-encode nested-array arguments as a JSON string instead of sending the actual array.
 *  Rather than silently treating that string as an (empty, or character-iterated) array — which
 *  previously crashed deep inside planMultiEdit with an uncaught TypeError — detect the string
 *  case and attempt to JSON.parse it; if it parses to a real array, use that. Any other shape
 *  (not a string, not an array, or a string that fails to parse / doesn't parse to an array) is
 *  reported back as a normal tool error the model can see and correct.
 *
 *  `defaultPath` backs the top-level `path` convenience argument: when every edit in the batch
 *  targets the same file, models frequently omit `path` on each individual entry (as if it were
 *  inherited), which previously failed validation with "each entry needs string path". Any entry
 *  missing/empty `path` gets `defaultPath` filled in here; entries that already specify their own
 *  path (e.g. a batch spanning multiple files) are left untouched, so mixed-file batches still work.
 */
export function normalizeEditsArg(
  rawEdits: unknown,
  defaultPath?: string
): { ok: true; edits: MultiEditOp[] } | { ok: false; summary: string } {
  const applyDefaultPath = (edits: MultiEditOp[]): MultiEditOp[] => {
    if (!defaultPath) return edits
    return edits.map((op) =>
      op && typeof op === 'object' && (typeof op.path !== 'string' || op.path.length === 0)
        ? { ...op, path: defaultPath }
        : op
    )
  }
  if (Array.isArray(rawEdits)) return { ok: true, edits: applyDefaultPath(rawEdits as MultiEditOp[]) }
  if (typeof rawEdits === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawEdits)
    } catch (e) {
      return {
        ok: false,
        summary: `multi_edit "edits" was a string but not valid JSON (${e instanceof Error ? e.message : String(e)}); pass edits as a real JSON array, not a stringified one`
      }
    }
    if (!Array.isArray(parsed)) {
      return {
        ok: false,
        summary: 'multi_edit "edits" was a JSON string but did not parse to an array; it must be an array of {path, old_string, new_string} objects'
      }
    }
    return { ok: true, edits: applyDefaultPath(parsed as MultiEditOp[]) }
  }
  return { ok: false, summary: 'multi_edit called with no edits' }
}

export async function multiEditFileTool(
  args: { edits: MultiEditOp[]; path?: string },
  root?: string
): Promise<ToolResultPayload> {
  const normalized = normalizeEditsArg(args.edits, args.path)
  if (!normalized.ok) {
    return { ok: false, summary: normalized.summary, error: 'no_edits' }
  }
  const edits = normalized.edits
  if (edits.length === 0) {
    return { ok: false, summary: 'multi_edit called with no edits', error: 'no_edits' }
  }

  const plan = await planMultiEdit(edits, true, root)
  if (!plan.ok) {
    return {
      ok: false,
      summary: plan.summary,
      error: plan.error,
      data: { ...plan.data, path: plan.path, editIndex: plan.index }
    }
  }

  // All edits validated in-memory — now write every changed file. Only files whose content
  // actually changed are touched (a file could theoretically end up unchanged if old_string
  // === new_string for every edit targeting it).
  const changed = plan.files.filter((f) => f.newContent !== f.oldContent)
  const diffs: string[] = []
  let totalEdits = 0
  for (const f of changed) {
    await writeFile(f.abs, fromLf(f.newContent, f.eol), 'utf8')
    const st = await stat(f.abs)
    fileReadCache.set(f.abs, { mtimeMs: st.mtimeMs, content: f.newContent })
    diffs.push(makeDiff(f.oldContent, f.newContent, f.path))
    totalEdits += f.editCount
  }

  return {
    ok: true,
    summary: `Edited ${changed.length} file${changed.length === 1 ? '' : 's'} (${totalEdits} edit${totalEdits === 1 ? '' : 's'})`,
    data: {
      paths: changed.map((f) => f.path),
      diff: diffs.join('\n'),
      files: changed.map((f) => ({ path: f.path, diff: makeDiff(f.oldContent, f.newContent, f.path) }))
    }
  }
}

/** Dry-run version of multiEditFileTool used to build the approval-dialog preview — computes
 *  the same plan and combined diff without touching disk or checking staleness (the user
 *  hasn't approved anything yet, so we don't want a stale-cache error blocking the preview
 *  itself; the real staleness check still runs when the tool actually executes post-approval). */
export async function previewMultiEdit(edits: MultiEditOp[], root?: string): Promise<{ paths: string[]; diff?: string }> {
  const plan = await planMultiEdit(edits, false, root)
  if (!plan.ok) {
    return { paths: [...new Set(edits.map((e) => (typeof e?.path === 'string' ? e.path : '')).filter(Boolean))] }
  }
  const changed = plan.files.filter((f) => f.newContent !== f.oldContent)
  return {
    paths: changed.map((f) => f.path),
    diff: changed.map((f) => makeDiff(f.oldContent, f.newContent, f.path)).join('\n')
  }
}

export async function deleteFileTool(args: { path: string }, root?: string): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  if (!assertInRoot(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  let oldContent = ''
  try {
    oldContent = toLf(await readFile(abs, 'utf8'))
  } catch {
    return { ok: false, summary: 'File not found', error: 'not_found' }
  }
  await unlink(abs)
  fileReadCache.delete(abs)
  return {
    ok: true,
    summary: `Deleted ${args.path}`,
    data: { path: args.path, diff: makeDiff(oldContent, '', args.path) }
  }
}
