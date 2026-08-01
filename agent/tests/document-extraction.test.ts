import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere
import { extractDocumentContent, MAX_DOCUMENT_FILE_BYTES, MAX_DOCUMENT_TEXT_CHARS } from '../src/main/agent/documents/extract'

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

let workspaceDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-extract-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-extract-'))
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('extractDocumentContent', () => {
  test('extracts a .txt file as plain UTF-8 text', async () => {
    const result = await extractDocumentContent({ filename: 'notes.txt', mimeType: 'text/plain', base64: b64('hello world') })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.extractedText).toBe('hello world')
      expect(result.truncated).toBe(false)
      expect(result.filename).toBe('notes.txt')
      expect(result.sizeBytes).toBe(Buffer.byteLength('hello world'))
    }
  })

  test('extracts a .md file as plain UTF-8 text', async () => {
    const result = await extractDocumentContent({ filename: 'README.md', mimeType: 'text/markdown', base64: b64('# Title\n\nBody text') })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.extractedText).toContain('# Title')
    }
  })

  test('normalizes CRLF line endings to LF', async () => {
    const result = await extractDocumentContent({ filename: 'crlf.txt', mimeType: 'text/plain', base64: b64('line1\r\nline2\r\nline3') })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.extractedText).toBe('line1\nline2\nline3')
    }
  })

  test('is case-insensitive on the extension check', async () => {
    const result = await extractDocumentContent({ filename: 'FILE.TXT', mimeType: 'text/plain', base64: b64('x') })
    expect(result.ok).toBe(true)
  })

  test('rejects unsupported extensions', async () => {
    const result = await extractDocumentContent({ filename: 'evil.exe', mimeType: 'application/octet-stream', base64: b64('binary') })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Unsupported file type')
      expect(result.error).toContain('.exe')
    }
  })

  test('rejects a filename with no extension', async () => {
    const result = await extractDocumentContent({ filename: 'noext', mimeType: 'text/plain', base64: b64('x') })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('Unsupported file type')
  })

  test('rejects invalid base64 gracefully rather than throwing', async () => {
    // Buffer.from with 'base64' encoding does not throw on most malformed input (it just decodes
    // what it can), so this exercises the decode path without asserting a throw — the function
    // must resolve to a result either way, never reject/throw.
    await expect(extractDocumentContent({ filename: 'x.txt', mimeType: 'text/plain', base64: 'not-valid-base64!!!' })).resolves.toBeDefined()
  })

  test('rejects empty files', async () => {
    const result = await extractDocumentContent({ filename: 'empty.txt', mimeType: 'text/plain', base64: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('empty')
  })

  test('rejects files larger than MAX_DOCUMENT_FILE_BYTES', async () => {
    const big = Buffer.alloc(MAX_DOCUMENT_FILE_BYTES + 1024, 'a').toString('base64')
    const result = await extractDocumentContent({ filename: 'big.txt', mimeType: 'text/plain', base64: big })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('too large')
      expect(result.error).toContain('MB')
    }
  })

  test('truncates extracted text past MAX_DOCUMENT_TEXT_CHARS and sets truncated=true', async () => {
    const longText = 'a'.repeat(MAX_DOCUMENT_TEXT_CHARS + 500)
    const result = await extractDocumentContent({ filename: 'long.txt', mimeType: 'text/plain', base64: b64(longText) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(true)
      expect(result.extractedText.length).toBeLessThan(longText.length)
      expect(result.extractedText).toContain('[truncated]')
    }
  })

  test('does not truncate text exactly at the cap', async () => {
    const exactText = 'b'.repeat(MAX_DOCUMENT_TEXT_CHARS)
    const result = await extractDocumentContent({ filename: 'exact.txt', mimeType: 'text/plain', base64: b64(exactText) })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.truncated).toBe(false)
      expect(result.extractedText).toBe(exactText)
    }
  })

  test('rejects a corrupt .docx file with a parse error rather than throwing', async () => {
    const result = await extractDocumentContent({
      filename: 'corrupt.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: b64('this is not a real zip/docx file')
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Failed to parse .docx file')
    }
  })

  test('extracts a real .docx round-tripped through writeDocxTool', async () => {
    const { writeDocxTool } = await import('../src/main/agent/docx/index')
    const path = 'extract-fixture.docx'
    const written = await writeDocxTool({ path, children: [{ type: 'paragraph', text: 'Hello from a real docx' }] })
    expect(written.ok).toBe(true)
    const fs = await import('node:fs/promises')
    const { getWorkspace } = await import('../src/main/workspace')
    const absPath = `${getWorkspace()}/${path}`
    const buffer = await fs.readFile(absPath)
    const result = await extractDocumentContent({
      filename: 'extract-fixture.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      base64: buffer.toString('base64')
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.extractedText).toContain('Hello from a real docx')
    }
    await fs.unlink(absPath).catch(() => {})
  })
})
