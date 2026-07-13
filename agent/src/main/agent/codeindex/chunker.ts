import { createHash } from 'node:crypto'

export interface CodeChunk {
  text: string
  startLine: number
  endLine: number
  /** stable content hash — used to skip re-embedding unchanged chunks on re-scan */
  hash: string
}

// Rough token estimate (~4 chars/token for code) — good enough for chunk sizing,
// we don't need exact tokenization here since embedding models truncate anyway.
const CHARS_PER_TOKEN = 4
const TARGET_TOKENS = 300
const MAX_TOKENS = 400
const OVERLAP_TOKENS = 50

const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN
const OVERLAP_CHARS = OVERLAP_TOKENS * CHARS_PER_TOKEN

export function hashChunkText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Splits file content into code-aware chunks of roughly TARGET_TOKENS, preferring to
 * break on blank lines (paragraph/function/class boundaries in most languages) rather
 * than mid-statement. Falls back to a fixed-size cut with overlap when no good boundary
 * exists within MAX_TOKENS (e.g. one giant minified line or a huge function body).
 */
export function chunkFile(content: string): CodeChunk[] {
  const lines = content.split('\n')
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return []

  const chunks: CodeChunk[] = []
  let startLine = 0 // 0-indexed internally, reported as 1-indexed

  while (startLine < lines.length) {
    let endLine = startLine
    let charCount = lines[startLine].length + 1
    let lastGoodBreak = -1

    while (endLine + 1 < lines.length) {
      const nextLen = lines[endLine + 1].length + 1
      if (charCount + nextLen > MAX_CHARS) break
      endLine++
      charCount += nextLen
      if (lines[endLine].trim() === '' && charCount >= TARGET_CHARS) {
        lastGoodBreak = endLine
      }
    }

    // Prefer the blank-line boundary if we found one at/after the target size.
    if (lastGoodBreak !== -1 && lastGoodBreak > startLine) {
      endLine = lastGoodBreak
    }

    const text = lines.slice(startLine, endLine + 1).join('\n')
    if (text.trim().length > 0) {
      chunks.push({
        text,
        startLine: startLine + 1,
        endLine: endLine + 1,
        hash: hashChunkText(text)
      })
    }

    if (endLine + 1 >= lines.length) break

    // Overlap: back up roughly OVERLAP_CHARS worth of lines from the end of this chunk
    // so context isn't lost right at a chunk boundary. Guaranteed forward progress:
    // nextStart is clamped to at least startLine + 1.
    let overlapChars = 0
    let nextStart = endLine + 1
    while (nextStart > startLine + 1 && overlapChars < OVERLAP_CHARS) {
      nextStart--
      overlapChars += lines[nextStart].length + 1
    }
    startLine = Math.max(nextStart, startLine + 1)
  }

  return chunks
}
