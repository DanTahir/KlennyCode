import { readFile, writeFile, unlink, stat, mkdir } from 'node:fs/promises'
import { dirname, resolve, isAbsolute, sep } from 'node:path'
import type { ToolResultPayload } from '@shared/types'
import { buildEditNotFoundHelp, countOccurrences, resolveEditMatch } from './edit-match'
import { detectEol, fromLf, toLf, type Eol } from './eol'
import { makeDiff } from './diff'
import { assertMutationAllowed, getWorkspace } from '../../workspace'
import { checkPawprintWriteGuard, checkPawprintStateSize } from '../pawprints/writeGuard'

/** Combines the write-scope guard with the oversized-state-write check for write_file, which
 *  (unlike edit_file/multi_edit) writes a brand-new full body rather than patching in place, so
 *  the size check applies to `content` directly rather than to a post-edit computed string. */
function checkPawprintGuardFor(abs: string, content: string): { allowed: boolean; reason?: string } {
  const guard = checkPawprintWriteGuard(abs)
  if (!guard.allowed) return guard
  return checkPawprintStateSizeFor(abs, content)
}

/** Only enforces the size cap for paths the write-scope guard already allows (i.e. under
 *  `state/**`) — irrelevant/no-op for every other path, including all non-Pawprint files. */
function checkPawprintStateSizeFor(abs: string, content: string): { allowed: boolean; reason?: string } {
  if (!abs.includes(`${sep}pawprints${sep}`)) return { allowed: true }
  return checkPawprintStateSize(Buffer.byteLength(content, 'utf8'))
}

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

// read_file (and grep/glob, see search.ts) are deliberately NOT sandboxed for absolute paths —
// per user request, they're global, read-only tools that can see anything the OS user running
// Klenny can see (any absolute path on the host, or a path relative to `root`/the open
// workspace). write_file/edit_file/multi_edit/delete_file remain sandboxed to `root`/the
// workspace, plus the always-allowed global `~/.klenny` and Electron userData directories (see
// assertMutationAllowed in workspace.ts) since mutation is the operation that actually needs the
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
  if (!assertMutationAllowed(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const pawprintGuard = checkPawprintGuardFor(abs, args.content)
  if (!pawprintGuard.allowed) return { ok: false, summary: pawprintGuard.reason!, error: 'pawprint_write_guard' }
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
  if (!assertMutationAllowed(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const pawprintGuardCheck = checkPawprintWriteGuard(abs)
  if (!pawprintGuardCheck.allowed) return { ok: false, summary: pawprintGuardCheck.reason!, error: 'pawprint_write_guard' }
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
  const stateSizeCheck = checkPawprintStateSizeFor(abs, next)
  if (!stateSizeCheck.allowed) return { ok: false, summary: stateSizeCheck.reason!, error: 'pawprint_write_guard' }
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
    if (!assertMutationAllowed(abs, root)) {
      return { ok: false, index: i, path: op.path, summary: 'Path outside workspace', error: 'sandbox' }
    }
    const pawprintGuardCheck = checkPawprintWriteGuard(abs)
    if (!pawprintGuardCheck.allowed) {
      return { ok: false, index: i, path: op.path, summary: pawprintGuardCheck.reason!, error: 'pawprint_write_guard' }
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

    const stateSizeCheck = checkPawprintStateSizeFor(abs, planned.newContent)
    if (!stateSizeCheck.allowed) {
      return { ok: false, index: i, path: op.path, summary: stateSizeCheck.reason!, error: 'pawprint_write_guard' }
    }
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

export interface MultiWriteOp {
  path: string
  content: string
}

interface PlannedFileWrite {
  path: string
  abs: string
  eol: Eol
  oldContent: string
  newContent: string
  existed: boolean
}

interface PlanMultiWriteError {
  ok: false
  index: number
  path: string
  summary: string
  error: string
  data?: Record<string, unknown>
}

/** Keys a model might plausibly use for an entry's target path instead of `path`. Order matters
 *  only for which alias wins if several are present (first hit). */
const PATH_ALIASES = ['path', 'file', 'file_path', 'filePath', 'filepath', 'filename', 'fileName', 'name'] as const
/** Ditto for an entry's body. `content` is the schema's name; the rest are observed/likely
 *  synonyms. Deliberately does NOT include `data` — too generic, and a `data` key is more likely
 *  to be a wrapper object than the file body itself. */
const CONTENT_ALIASES = ['content', 'contents', 'text', 'body', 'source', 'code'] as const

function firstAliasKey(obj: Record<string, unknown>, aliases: readonly string[]): string | undefined {
  return aliases.find((k) => Object.prototype.hasOwnProperty.call(obj, k))
}

/** Coerces whatever a model put in an entry's content slot into a real string.
 *
 *  Tolerated shapes, all of which have been seen from real models asked to write files:
 *   - a plain string (the schema's contract — passed through untouched)
 *   - an array of lines (joined with \n; nested/non-string items stringified)
 *   - a number/boolean (stringified — e.g. a one-line config value)
 *   - an object (JSON.stringify'd with 2-space indent — common when writing a .json file, where
 *     the model sends the object it wants serialized rather than pre-serialized text)
 *
 *  Missing/null/undefined content is deliberately NOT coerced to '' — multi_write overwrites, so
 *  silently turning a malformed entry into a file-truncating empty write is the one failure mode
 *  worth being strict about. An explicit empty string is still perfectly valid (an intentionally
 *  empty file). */
function coerceWriteContent(raw: unknown): { ok: true; content: string } | { ok: false; reason: string } {
  if (typeof raw === 'string') return { ok: true, content: raw }
  if (Array.isArray(raw)) {
    return {
      ok: true,
      content: raw.map((line) => (typeof line === 'string' ? line : line === null || line === undefined ? '' : String(line))).join('\n')
    }
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return { ok: true, content: String(raw) }
  if (raw === null || raw === undefined) {
    return { ok: false, reason: 'missing "content" (pass an empty string if you really want an empty file)' }
  }
  if (typeof raw === 'object') {
    try {
      return { ok: true, content: `${JSON.stringify(raw, null, 2)}\n` }
    } catch {
      return { ok: false, reason: '"content" was an object that could not be serialized to JSON' }
    }
  }
  return { ok: false, reason: `"content" had unsupported type ${typeof raw}` }
}

/** Normalizes one raw entry into {path, content}, tolerating key aliases and content shapes. */
function normalizeWriteEntry(raw: unknown): { ok: true; op: MultiWriteOp } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'each entry must be an object with "path" and "content"' }
  }
  const obj = raw as Record<string, unknown>
  const pathKey = firstAliasKey(obj, PATH_ALIASES)
  const rawPath = pathKey ? obj[pathKey] : undefined
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { ok: false, reason: 'missing/empty "path"' }
  }
  const contentKey = firstAliasKey(obj, CONTENT_ALIASES)
  const coerced = coerceWriteContent(contentKey ? obj[contentKey] : undefined)
  if (!coerced.ok) return { ok: false, reason: coerced.reason }
  return { ok: true, op: { path: rawPath.trim(), content: coerced.content } }
}

/** True when an object looks like a single {path, content} entry rather than a path→content map. */
function looksLikeSingleEntry(obj: Record<string, unknown>): boolean {
  return firstAliasKey(obj, PATH_ALIASES) !== undefined && firstAliasKey(obj, CONTENT_ALIASES) !== undefined
}

/**
 * Turns whatever arrived in `files` into a real MultiWriteOp[], mirroring normalizeEditsArg's
 * tolerance (see its doc comment) and then some — because the ways a model can mangle a
 * "write several files" call are strictly broader than for a batch edit.
 *
 * Accepted shapes:
 *  - a real array of entries (the schema's contract)
 *  - a JSON-encoded string of any of these (some providers double-encode nested-array args)
 *  - a single entry object, not wrapped in an array ({path, content})
 *  - a path→content map ({"src/a.ts": "...", "src/b.ts": "..."}) — a very natural shape for a
 *    model to reach for when the whole point of the call is "these files, these contents"
 *  - per-entry key aliases (file/file_path/filename/... and contents/text/body/source/code)
 *  - per-entry content as an array of lines, a number/boolean, or an object to serialize
 *
 * `fallback` backs the degenerate single-file call multi_write({path, content}) with no `files`
 * at all. There's no multi_edit-style top-level *default* path here (every entry in a batch write
 * targets a different file by definition, so a shared default would be meaningless) — this is
 * only used when `files` is absent/empty entirely.
 */
export function normalizeFilesArg(
  rawFiles: unknown,
  fallback?: { path?: unknown; content?: unknown }
): { ok: true; files: MultiWriteOp[] } | { ok: false; summary: string } {
  const fromArray = (arr: unknown[]): { ok: true; files: MultiWriteOp[] } | { ok: false; summary: string } => {
    const out: MultiWriteOp[] = []
    for (let i = 0; i < arr.length; i++) {
      const entry = normalizeWriteEntry(arr[i])
      if (!entry.ok) {
        return { ok: false, summary: `multi_write entry at index ${i} is malformed: ${entry.reason}` }
      }
      out.push(entry.op)
    }
    return { ok: true, files: out }
  }

  const fromObject = (obj: Record<string, unknown>): { ok: true; files: MultiWriteOp[] } | { ok: false; summary: string } => {
    if (looksLikeSingleEntry(obj)) {
      const entry = normalizeWriteEntry(obj)
      return entry.ok ? { ok: true, files: [entry.op] } : { ok: false, summary: `multi_write "files" is malformed: ${entry.reason}` }
    }
    // Treat as a path -> content map.
    const out: MultiWriteOp[] = []
    for (const [key, value] of Object.entries(obj)) {
      if (typeof key !== 'string' || key.trim().length === 0) continue
      const coerced = coerceWriteContent(value)
      if (!coerced.ok) {
        return { ok: false, summary: `multi_write entry "${key}" is malformed: ${coerced.reason}` }
      }
      out.push({ path: key.trim(), content: coerced.content })
    }
    if (out.length === 0) {
      return { ok: false, summary: 'multi_write "files" was an object with no usable path/content pairs' }
    }
    return { ok: true, files: out }
  }

  if (Array.isArray(rawFiles)) {
    if (rawFiles.length > 0) return fromArray(rawFiles)
    // fall through to the single-file fallback below for an explicitly empty array
  } else if (typeof rawFiles === 'string') {
    const trimmed = rawFiles.trim()
    if (trimmed.length > 0) {
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch (e) {
        return {
          ok: false,
          summary: `multi_write "files" was a string but not valid JSON (${e instanceof Error ? e.message : String(e)}); pass files as a real JSON array of {path, content} objects, not a stringified one`
        }
      }
      if (Array.isArray(parsed)) return fromArray(parsed)
      if (parsed && typeof parsed === 'object') return fromObject(parsed as Record<string, unknown>)
      return {
        ok: false,
        summary: 'multi_write "files" was a JSON string but did not parse to an array or object; it must be an array of {path, content} objects'
      }
    }
  } else if (rawFiles && typeof rawFiles === 'object') {
    return fromObject(rawFiles as Record<string, unknown>)
  }

  // No usable `files` — accept the degenerate single-file form multi_write({path, content}).
  if (fallback && typeof fallback.path === 'string' && fallback.path.trim().length > 0) {
    const entry = normalizeWriteEntry(fallback)
    if (!entry.ok) return { ok: false, summary: `multi_write called with a top-level path but ${entry.reason}` }
    return { ok: true, files: [entry.op] }
  }

  if (rawFiles === null || rawFiles === undefined) {
    return { ok: false, summary: 'multi_write called with no files' }
  }
  if (Array.isArray(rawFiles) || typeof rawFiles === 'string') {
    return { ok: false, summary: 'multi_write called with no files' }
  }
  return {
    ok: false,
    summary: `multi_write "files" must be an array of {path, content} objects (got ${typeof rawFiles})`
  }
}

/** Shared by multiWriteFileTool (real run) and its approval preview (dry run): validates every
 *  entry and computes each file's before/after content without touching disk. All-or-nothing like
 *  planMultiEdit — the first bad entry aborts the whole batch, so a malformed 5th file never
 *  leaves the first 4 written.
 *
 *  Unlike planMultiEdit there is no staleness check and no "file must already exist" requirement:
 *  creating new files is the entire point, and an overwrite doesn't depend on having read the
 *  previous contents first (same reasoning as writeFileTool, which also skips the stale guard).
 *  Duplicate paths within one batch are collapsed last-write-wins, keyed by resolved absolute
 *  path so 'a.ts' and './a.ts' count as the same file. */
async function planMultiWrite(
  files: MultiWriteOp[],
  root?: string
): Promise<{ ok: true; files: PlannedFileWrite[] } | PlanMultiWriteError> {
  const planned = new Map<string, PlannedFileWrite>()

  for (let i = 0; i < files.length; i++) {
    const op = files[i]
    if (!op || typeof op.path !== 'string' || op.path.length === 0 || typeof op.content !== 'string') {
      return {
        ok: false,
        index: i,
        path: typeof op?.path === 'string' ? op.path : '',
        summary: `Malformed entry at index ${i}: each entry needs a string "path" and string "content"`,
        error: 'invalid_file'
      }
    }

    let abs: string
    try {
      abs = resolveWorkspacePath(op.path, root)
    } catch (e) {
      return {
        ok: false,
        index: i,
        path: op.path,
        summary: e instanceof Error ? e.message : String(e),
        error: 'invalid_path'
      }
    }

    if (!assertMutationAllowed(abs, root)) {
      return { ok: false, index: i, path: op.path, summary: 'Path outside workspace', error: 'sandbox' }
    }

    const normalizedNew = toLf(op.content)
    const pawprintGuard = checkPawprintGuardFor(abs, normalizedNew)
    if (!pawprintGuard.allowed) {
      return { ok: false, index: i, path: op.path, summary: pawprintGuard.reason!, error: 'pawprint_write_guard' }
    }

    const existing = planned.get(abs)
    if (existing) {
      // Same file targeted twice in one batch — last write wins, but keep the original
      // oldContent/eol so the diff still describes the change from what's actually on disk.
      existing.path = op.path
      existing.newContent = normalizedNew
      continue
    }

    let oldRaw = ''
    let existed = false
    try {
      oldRaw = await readFile(abs, 'utf8')
      existed = true
    } catch {
      // new file — diff against empty content
    }
    // Preserve an existing file's EOL convention (LF for new files), exactly like writeFileTool,
    // so overwriting a CRLF file doesn't rewrite every line ending just because model output is LF.
    planned.set(abs, {
      path: op.path,
      abs,
      eol: existed ? detectEol(oldRaw) : '\n',
      oldContent: toLf(oldRaw),
      newContent: normalizedNew,
      existed
    })
  }

  return { ok: true, files: [...planned.values()] }
}

export async function multiWriteFileTool(
  args: { files?: unknown; path?: unknown; content?: unknown },
  root?: string
): Promise<ToolResultPayload> {
  const normalized = normalizeFilesArg(args?.files, { path: args?.path, content: args?.content })
  if (!normalized.ok) {
    return { ok: false, summary: normalized.summary, error: 'no_files' }
  }
  if (normalized.files.length === 0) {
    return { ok: false, summary: 'multi_write called with no files', error: 'no_files' }
  }

  const plan = await planMultiWrite(normalized.files, root)
  if (!plan.ok) {
    return {
      ok: false,
      summary: plan.summary,
      error: plan.error,
      data: { ...plan.data, path: plan.path, fileIndex: plan.index }
    }
  }

  // Every entry validated in memory — only now does anything hit disk.
  const written: PlannedFileWrite[] = []
  const diffs: string[] = []
  for (const f of plan.files) {
    await mkdir(dirname(f.abs), { recursive: true })
    await writeFile(f.abs, fromLf(f.newContent, f.eol), 'utf8')
    const st = await stat(f.abs)
    fileReadCache.set(f.abs, { mtimeMs: st.mtimeMs, content: f.newContent })
    written.push(f)
    diffs.push(makeDiff(f.oldContent, f.newContent, f.path))
  }

  const createdCount = written.filter((f) => !f.existed).length
  const overwroteCount = written.length - createdCount
  const detail = [createdCount > 0 ? `${createdCount} created` : '', overwroteCount > 0 ? `${overwroteCount} overwritten` : '']
    .filter(Boolean)
    .join(', ')

  return {
    ok: true,
    summary: `Wrote ${written.length} file${written.length === 1 ? '' : 's'}${detail ? ` (${detail})` : ''}`,
    data: {
      paths: written.map((f) => f.path),
      diff: diffs.filter(Boolean).join('\n'),
      files: written.map((f) => ({ path: f.path, diff: makeDiff(f.oldContent, f.newContent, f.path), created: !f.existed }))
    }
  }
}

/** Dry-run version of multiWriteFileTool for the approval dialog — same plan and combined diff,
 *  nothing written. Degrades to a bare path list (never throws) if planning fails, so a malformed
 *  batch still renders a rejectable preview instead of crashing the turn and leaving the tool
 *  call stuck at "running" — same hard-won contract as previewMultiEdit. */
export async function previewMultiWrite(
  files: MultiWriteOp[],
  root?: string
): Promise<{ paths: string[]; diff?: string }> {
  const plan = await planMultiWrite(files, root)
  if (!plan.ok) {
    return { paths: [...new Set(files.map((f) => (typeof f?.path === 'string' ? f.path : '')).filter(Boolean))] }
  }
  const diff = plan.files.map((f) => makeDiff(f.oldContent, f.newContent, f.path)).filter(Boolean).join('\n')
  return { paths: plan.files.map((f) => f.path), diff: diff || undefined }
}

export async function deleteFileTool(args: { path: string }, root?: string): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  if (!assertMutationAllowed(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const pawprintGuardCheck = checkPawprintWriteGuard(abs)
  if (!pawprintGuardCheck.allowed) return { ok: false, summary: pawprintGuardCheck.reason!, error: 'pawprint_write_guard' }
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
