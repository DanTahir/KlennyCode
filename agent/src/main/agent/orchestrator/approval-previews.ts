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
import { loadDocxPackage } from '../docx/package'
import { buildDocxModel } from '../docx/model'
import { applyEditOp, type DocxEditOp } from '../docx/ops'
import { readSource, readManifest } from '../pawprints/storage'
import { validateDomainList } from '../pawprints/domains'
import { resolvePackages } from '../pawprints/packagePipeline'

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
  if (name === 'create_pawprint' || name === 'update_pawprint') {
    return previewPawprintApproval(name, args)
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
  if (name === 'write_docx') {
    // .docx is a binary zip — there's no meaningful text diff for a from-scratch write, so the
    // preview is just a structural summary of what will be generated.
    const children = Array.isArray(args.children) ? (args.children as Array<{ type?: string }>) : []
    const counts: Record<string, number> = {}
    for (const c of children) {
      const t = c?.type ?? 'paragraph'
      counts[t] = (counts[t] ?? 0) + 1
    }
    const partsDesc = Object.entries(counts)
      .map(([t, n]) => `${n} ${t}${n === 1 ? '' : 's'}`)
      .join(', ')
    return {
      title: `Write ${path}`,
      extra: { filePath: path, command: `New .docx with ${partsDesc || 'no content'}` }
    }
  }
  if (name === 'edit_docx') {
    // Dry-run the ops against an in-memory copy of the package (never written to disk here) so
    // the approval dialog can show a real before/after plaintext diff alongside the plain-English
    // operation descriptions — mirrors edit_docx's own diff generation in docx/edit.ts.
    const ops = Array.isArray(args.ops) ? (args.ops as DocxEditOp[]) : []
    const opsDesc = ops.map((o) => (o && typeof o === 'object' && 'op' in o ? String((o as { op: unknown }).op) : 'op')).join(', ')
    try {
      const abs = resolveWorkspacePath(path, root)
      const buf = await readFile(abs)
      const pkg = await loadDocxPackage(buf)
      const beforeText = (await buildDocxModel(pkg)).plainText
      for (const op of ops) await applyEditOp(pkg, op)
      const afterText = (await buildDocxModel(pkg)).plainText
      return {
        title: `Edit ${path} (${ops.length} op${ops.length === 1 ? '' : 's'})`,
        extra: {
          filePath: path,
          command: opsDesc,
          diff: beforeText !== afterText ? makeDiff(beforeText, afterText, path) : undefined
        }
      }
    } catch {
      return { title: `Edit ${path} (${ops.length} op${ops.length === 1 ? '' : 's'})`, extra: { filePath: path, command: opsDesc } }
    }
  }
  if (name === 'multi_edit') {
    const normalized = normalizeEditsArg(args.edits, typeof args.path === 'string' ? args.path : undefined)
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

/** Builds the combined create_pawprint/update_pawprint approval preview: name/description,
 *  source diff (against empty for create, against the existing approved source for update),
 *  requested extra packages (dry-run resolved via the same package pipeline used at execution
 *  time, so the approval dialog shows real resolved transitive versions, not just what the agent
 *  requested), and requested domains (format/count validated the same way execution-time does).
 *  Never writes anything to disk — purely a preview. If package/domain validation fails here,
 *  the preview still renders (with an error note) rather than throwing, so the user always gets
 *  to see *something* and reject cleanly; the same validation runs again, authoritatively, in
 *  manager.ts's createPawprint/updatePawprint at execution time after approval. */
async function previewPawprintApproval(
  name: 'create_pawprint' | 'update_pawprint',
  args: Record<string, unknown>
): Promise<{ title: string; extra: Partial<PendingAction> }> {
  const pawprintName = name === 'create_pawprint' ? String(args.name ?? '') : undefined
  const pawprintId = name === 'update_pawprint' ? String(args.pawprintId ?? '') : undefined
  const newSource = String(args.source ?? '')

  let oldSource = ''
  let displayName = pawprintName
  if (name === 'update_pawprint' && pawprintId) {
    oldSource = (await readSource(pawprintId).catch(() => null)) ?? ''
    const manifest = await readManifest(pawprintId).catch(() => null)
    displayName = manifest?.name ?? pawprintId
  }

  const requestedPackages = Array.isArray(args.packages)
    ? (args.packages as unknown[]).filter(
        (p): p is { name: string; version: string } => !!p && typeof p === 'object' && 'name' in p && 'version' in p
      )
    : []
  const requestedDomains = Array.isArray(args.domains) ? (args.domains as unknown[]).filter((d): d is string => typeof d === 'string') : []

  let pawprintPackages: { name: string; version: string; direct: boolean }[] | undefined
  let pawprintDomains: string[] | undefined
  const notes: string[] = []

  if (requestedPackages.length > 0) {
    const result = await resolvePackages(requestedPackages).catch(
      (e) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) })
    )
    if (result.ok) {
      pawprintPackages = result.packages.map((p) => ({ name: p.ref.name, version: p.ref.version, direct: p.ref.direct }))
    } else {
      notes.push(`Package resolution preview failed: ${result.error}`)
    }
  }

  if (requestedDomains.length > 0) {
    const domainCheck = validateDomainList(requestedDomains)
    if (domainCheck.ok) {
      pawprintDomains = domainCheck.hostnames
    } else {
      notes.push(`Domain validation preview failed: ${domainCheck.error}`)
    }
  }

  const diff = oldSource !== newSource ? makeDiff(oldSource, newSource, `${displayName ?? 'Pawprint'}/App.tsx`) : undefined
  const title = name === 'create_pawprint' ? `Create Pawprint "${displayName ?? ''}"` : `Update Pawprint "${displayName ?? pawprintId ?? ''}"`

  return {
    title,
    extra: {
      pawprintName: displayName,
      pawprintPackages,
      pawprintDomains,
      diff,
      command: notes.length > 0 ? notes.join(' ') : undefined
    }
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
