// Extraction logic for the "Attach Document to Chat" feature — turns a just-uploaded .md/.txt/
// .docx file into model-readable text, used by the chat:extractDocument IPC handler (see ipc.ts).
// Runs at attach time (not send time) so the renderer's pending-attachment UI can surface a
// parse/size error immediately instead of only failing once the user hits Send.
import type { ExtractDocumentRequest, ExtractDocumentResult } from '@shared/ipc'
import { toLf } from '../tools/eol'
import { loadDocxPackage } from '../docx/package'
import { buildDocxModel } from '../docx/model'

/** Hard cap on extractedText length, matching compactToolResult's convention in messages.ts. */
export const MAX_DOCUMENT_TEXT_CHARS = 40_000

/** Hard cap on the raw uploaded file size, matching the client-side check in ChatPane. */
export const MAX_DOCUMENT_FILE_BYTES = 8 * 1024 * 1024

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.docx'] as const

function extOf(filename: string): string {
  const idx = filename.toLowerCase().lastIndexOf('.')
  return idx === -1 ? '' : filename.toLowerCase().slice(idx)
}

/** Extracts model-readable text from an uploaded document. Never throws — all failure modes
 *  (bad extension, oversized file, corrupt .docx) resolve to `{ ok: false, error }` so the IPC
 *  handler can hand a clean message straight back to the renderer. */
export async function extractDocumentContent(request: ExtractDocumentRequest): Promise<ExtractDocumentResult> {
  const { filename, mimeType } = request
  const ext = extOf(filename)
  if (!ALLOWED_EXTENSIONS.includes(ext as (typeof ALLOWED_EXTENSIONS)[number])) {
    return { ok: false, error: `Unsupported file type "${ext || filename}". Only .md, .txt, and .docx are supported.` }
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(request.base64, 'base64')
  } catch (e) {
    return { ok: false, error: `Failed to decode uploaded file: ${e instanceof Error ? e.message : String(e)}` }
  }

  if (buffer.length > MAX_DOCUMENT_FILE_BYTES) {
    return {
      ok: false,
      error: `File is too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max size is ${MAX_DOCUMENT_FILE_BYTES / 1024 / 1024} MB.`
    }
  }
  if (buffer.length === 0) {
    return { ok: false, error: 'File is empty.' }
  }

  if (ext === '.md' || ext === '.txt') {
    const text = toLf(buffer.toString('utf8'))
    return finalize(filename, mimeType, text, buffer.length)
  }

  // .docx: reuse the same OOXML -> JSON projection as read_docx so the model gets full
  // structural fidelity (headings, tables, formatting) rather than a lossy plain-text dump.
  try {
    const pkg = await loadDocxPackage(buffer)
    const model = await buildDocxModel(pkg)
    const fullJson = JSON.stringify(model)
    if (fullJson.length <= MAX_DOCUMENT_TEXT_CHARS) {
      return finalize(filename, mimeType, fullJson, buffer.length)
    }
    // Full structured JSON would blow the cap — slicing serialized JSON at a fixed offset could
    // produce invalid/truncated structure, so fall back to just the plain-text rendering instead.
    return finalize(filename, mimeType, model.plainText, buffer.length)
  } catch (e) {
    return { ok: false, error: `Failed to parse .docx file: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function finalize(filename: string, mimeType: string, text: string, sizeBytes: number): ExtractDocumentResult {
  let extractedText = text
  let truncated = false
  if (extractedText.length > MAX_DOCUMENT_TEXT_CHARS) {
    extractedText = `${extractedText.slice(0, MAX_DOCUMENT_TEXT_CHARS)}\u2026[truncated]`
    truncated = true
  }
  return { ok: true, filename, mimeType, extractedText, truncated, sizeBytes }
}
