// read_docx tool implementation — see model.ts for the actual OOXML -> JSON projection.
import { readFile, stat } from 'node:fs/promises'
import type { ToolResultPayload } from '@shared/types'
import { resolveWorkspacePath } from '../tools/file-ops'
import { loadDocxPackage } from './package'
import { buildDocxModel } from './model'
import { noteDocxRead } from './edit'

export async function readDocxTool(args: { path: string }, root?: string): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  let buf: Buffer
  try {
    buf = await readFile(abs)
    const st = await stat(abs)
    noteDocxRead(abs, st.mtimeMs)
  } catch (e) {
    return { ok: false, summary: `File not found: ${args.path}`, error: 'not_found', data: { detail: e instanceof Error ? e.message : String(e) } }
  }
  let pkg
  try {
    pkg = await loadDocxPackage(buf)
  } catch (e) {
    return {
      ok: false,
      summary: `Not a valid .docx (zip) file: ${args.path}`,
      error: 'invalid_docx',
      data: { detail: e instanceof Error ? e.message : String(e) }
    }
  }
  let model
  try {
    model = await buildDocxModel(pkg)
  } catch (e) {
    return {
      ok: false,
      summary: `Failed to parse .docx structure: ${args.path}`,
      error: 'parse_error',
      data: { detail: e instanceof Error ? e.message : String(e) }
    }
  }

  const imageCount = model.paragraphs.reduce((n, p) => n + p.runs.filter((r) => r.image).length, 0)
  const revisionCount = model.paragraphs.reduce((n, p) => n + p.runs.filter((r) => r.revision).length, 0)
  const parts: string[] = [`${model.paragraphs.length} paragraphs`, `${model.tables.length} tables`]
  if (model.headers.length || model.footers.length) parts.push(`${model.headers.length} header(s)/${model.footers.length} footer(s)`)
  if (model.comments.length) parts.push(`${model.comments.length} comments`)
  if (imageCount) parts.push(`${imageCount} images`)
  if (revisionCount) parts.push(`${revisionCount} tracked-change runs`)

  return {
    ok: true,
    summary: `Read ${args.path} (${parts.join(', ')})`,
    data: { path: args.path, ...model }
  }
}
