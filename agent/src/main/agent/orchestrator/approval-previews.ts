// Preview builders for the manual-approval dialog (diff/title for a not-yet-run mutating tool
// call) and the spending-cap guard checked at the start of every user turn.
import { readFile } from 'node:fs/promises'
import type { PendingAction, TabSession } from '@shared/types'
import { resolveWorkspacePath, previewMultiEdit, normalizeEditsArg, type MultiEditOp } from '../tools/index'
import { toLf } from '../tools/eol'
import { makeDiff } from '../tools/diff'
import { resolveEditMatch } from '../tools/edit-match'
import { getDailySpend } from '../spend'
import { emitToAll } from './state'

export async function previewMutatingTool(
  name: string,
  args: Record<string, unknown>,
  /** Sandbox root for the mutation — the resolved Assistant documentsDirectory when this call
   *  came from an Assistant tab, otherwise undefined (falls back to the open workspace). See
   *  resolveWorkspacePath/assertInRoot in tools/file-ops.ts. */
  root?: string
): Promise<{ title: string; extra: Partial<PendingAction> }> {
  if (name === 'run_command') {
    return {
      title: `Run command: ${args.command}`,
      extra: { command: String(args.command), cwd: args.cwd ? String(args.cwd) : undefined }
    }
  }
  const path = String(args.path ?? '')
  if (name === 'write_file') {
    let oldContent = ''
    try {
      const abs = resolveWorkspacePath(path, root)
      oldContent = toLf(await readFile(abs, 'utf8'))
    } catch {
      // new file — diff against empty content
    }
    return { title: `Write ${path}`, extra: { filePath: path, diff: makeDiff(oldContent, String(args.content), path) } }
  }
  if (name === 'edit_file') {
    try {
      const abs = resolveWorkspacePath(path, root)
      const content = toLf(await readFile(abs, 'utf8'))
      const match = resolveEditMatch(content, String(args.old_string), String(args.new_string))
      if (!match) return { title: `Edit ${path}`, extra: { filePath: path } }
      const updated = args.replace_all
        ? content.replaceAll(match.oldString, match.newString)
        : content.replace(match.oldString, match.newString)
      return { title: `Edit ${path}`, extra: { filePath: path, diff: makeDiff(content, updated, path) } }
    } catch {
      return { title: `Edit ${path}`, extra: { filePath: path } }
    }
  }
  if (name === 'multi_edit') {
    const normalized = normalizeEditsArg(args.edits)
    const edits = (normalized.ok ? normalized.edits : []) as MultiEditOp[]
    // previewMultiEdit/planMultiEdit validate each edit and reject malformed paths cleanly, but
    // guard here too (matching the edit_file/write_file branches above) so any unexpected
    // failure degrades to a plain preview instead of crashing the whole tool call and leaving
    // its tool_call block stuck at "running" forever — see "multi_edit tool broken" fix.
    try {
      const { paths, diff } = await previewMultiEdit(edits, root)
      const title = paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files (${edits.length} edits)`
      return { title, extra: { filePaths: paths, diff } }
    } catch {
      const paths = [...new Set(edits.map((e) => (typeof e?.path === 'string' ? e.path : '')).filter(Boolean))]
      const title = paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length || edits.length} files (${edits.length} edits)`
      return { title, extra: { filePaths: paths } }
    }
  }
  try {
    const abs = resolveWorkspacePath(path, root)
    const oldContent = toLf(await readFile(abs, 'utf8'))
    return { title: `Delete ${path}`, extra: { filePath: path, diff: makeDiff(oldContent, '', path) } }
  } catch {
    return { title: `Delete ${path}`, extra: { filePath: path } }
  }
}

export function checkSpendCap(tab: TabSession, cap: number | null, period: 'session' | 'daily'): void {
  if (!cap) return
  const spend = period === 'daily' ? getDailySpend() : tab.totalCostUsd
  if (spend >= cap) {
    emitToAll({ type: 'spend_blocked', tabId: tab.id })
    throw new Error('Spending cap exceeded')
  }
}
