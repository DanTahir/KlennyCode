// edit_docx tool implementation — applies one or more surgical ops (see ops.ts) to an existing
// .docx, then re-serializes only the parts that were actually touched (package.ts preserves
// everything else byte-for-byte). Mirrors edit_file/multi_edit's stale-read guard: read_docx
// caches the file's mtime at read time, and edit_docx refuses to proceed if the file changed on
// disk since then, for the same reason edit_file does (avoid clobbering a concurrent change the
// model never saw).
import { readFile, writeFile, stat } from 'node:fs/promises'
import type { ToolResultPayload } from '@shared/types'
import { resolveWorkspacePath } from '../tools/file-ops'
import { assertInWorkspace, isInsideDirectory } from '../../workspace'
import { makeDiff } from '../tools/diff'
import { loadDocxPackage, saveDocxPackage } from './package'
import { buildDocxModel } from './model'
import { applyEditOp, type DocxEditOp } from './ops'

const docxReadCache = new Map<string, { mtimeMs: number }>()

/** Called by read_docx so a subsequent edit_docx on the same path can detect a concurrent
 *  on-disk change — exported here rather than living in read.ts to keep the cache + the code
 *  that checks it next to each other. */
export function noteDocxRead(absPath: string, mtimeMs: number): void {
  docxReadCache.set(absPath, { mtimeMs })
}

function assertInRoot(abs: string, root?: string): boolean {
  return root ? isInsideDirectory(abs, root) : assertInWorkspace(abs)
}

export interface EditDocxArgs {
  path: string
  ops: DocxEditOp[]
}

export async function editDocxTool(args: EditDocxArgs, root?: string): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  if (!assertInRoot(abs, root)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }

  if (!Array.isArray(args.ops) || args.ops.length === 0) {
    return { ok: false, summary: 'edit_docx called with no ops', error: 'no_ops' }
  }

  let buf: Buffer
  let st
  try {
    st = await stat(abs)
    buf = await readFile(abs)
  } catch (e) {
    return { ok: false, summary: `File not found: ${args.path}`, error: 'not_found', data: { detail: e instanceof Error ? e.message : String(e) } }
  }

  const cached = docxReadCache.get(abs)
  if (cached && cached.mtimeMs !== st.mtimeMs) {
    return {
      ok: false,
      summary: 'File changed on disk since last read',
      error: 'stale',
      data: { path: args.path, hint: 'Call read_docx again, then retry edit_docx with up-to-date paraIndex/runIndex values.' }
    }
  }

  let pkg
  try {
    pkg = await loadDocxPackage(buf)
  } catch (e) {
    return { ok: false, summary: `Not a valid .docx (zip) file: ${args.path}`, error: 'invalid_docx', data: { detail: e instanceof Error ? e.message : String(e) } }
  }

  let beforeText = ''
  try {
    beforeText = (await buildDocxModel(pkg)).plainText
  } catch {
    // Non-fatal — the diff preview just degrades to empty "before" text; ops themselves still run.
  }

  const descriptions: string[] = []
  for (let i = 0; i < args.ops.length; i++) {
    try {
      const result = await applyEditOp(pkg, args.ops[i])
      descriptions.push(result.description)
    } catch (e) {
      return {
        ok: false,
        summary: `Op ${i + 1} of ${args.ops.length} (${args.ops[i]?.op}) failed: ${e instanceof Error ? e.message : String(e)}`,
        error: 'op_failed',
        data: { opIndex: i, appliedSoFar: descriptions }
      }
    }
  }

  let afterText = ''
  try {
    afterText = (await buildDocxModel(pkg)).plainText
  } catch {
    // Same as above — cosmetic only.
  }

  const outBuf = await saveDocxPackage(pkg)
  await writeFile(abs, outBuf)
  const newStat = await stat(abs)
  docxReadCache.set(abs, { mtimeMs: newStat.mtimeMs })

  return {
    ok: true,
    summary: `Edited ${args.path} (${descriptions.length} op${descriptions.length === 1 ? '' : 's'})`,
    data: {
      path: args.path,
      operations: descriptions,
      // A textual diff of two plain-text renderings can't capture every formatting-only change
      // (e.g. changing a run's color moves no text), but it's a genuinely useful at-a-glance
      // view for anything that touched visible text/structure, alongside the plain-English
      // operations list above for changes a text diff can't show.
      diff: beforeText !== afterText ? makeDiff(beforeText, afterText, args.path) : undefined
    }
  }
}
