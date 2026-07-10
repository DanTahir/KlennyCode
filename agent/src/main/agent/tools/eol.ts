export type Eol = '\n' | '\r\n'

/**
 * Detects the dominant line-ending style of a file's contents.
 * Uses a majority vote over all newline occurrences so a stray CRLF (or LF) in an
 * otherwise-consistent file doesn't flip the detection.
 */
export function detectEol(content: string): Eol {
  const crlfCount = (content.match(/\r\n/g) ?? []).length
  const totalLfCount = (content.match(/\n/g) ?? []).length
  if (totalLfCount === 0) return '\n'
  return crlfCount / totalLfCount > 0.5 ? '\r\n' : '\n'
}

/** Normalizes any line-ending style (CRLF or LF) down to LF. */
export function toLf(content: string): string {
  return content.replace(/\r\n/g, '\n')
}

/** Converts LF-only content to the given EOL style. Assumes input has no bare \r\n already. */
export function fromLf(content: string, eol: Eol): string {
  return eol === '\r\n' ? content.replace(/\n/g, '\r\n') : content
}
