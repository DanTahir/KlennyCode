import { createTwoFilesPatch } from 'diff'

// Produces a real unified diff (proper LCS-based line alignment + hunk headers with
// surrounding context), instead of a naive index-by-index comparison. A naive comparison
// misaligns every line after the first insertion/deletion, making the whole rest of the
// file look changed — this is what made earlier diffs unreadable.
export function makeDiff(oldText: string, newText: string, path: string): string {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, oldText, newText, '', '', {
    context: 3
  })
  // createTwoFilesPatch's first two lines are the `Index:` / `===...` banner lines produced
  // by the underlying `structuredPatch`/`formatPatch` helpers; we only want the `--- `/`+++ `
  // header and hunks that follow, matching the format the UI's DiffViewer expects. The
  // `--- `/`+++ ` header lines also get a trailing tab appended by jsdiff when the (unused)
  // timestamp argument is an empty string, which we trim for a cleaner header.
  const lines = patch.split('\n')
  const headerStart = lines.findIndex((l) => l.startsWith('--- '))
  const body = headerStart >= 0 ? lines.slice(headerStart) : lines
  return body.map((l) => (l.startsWith('--- ') || l.startsWith('+++ ') ? l.replace(/\t$/, '') : l)).join('\n')
}
