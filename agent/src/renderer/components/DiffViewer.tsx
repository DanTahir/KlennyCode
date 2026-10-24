import { memo, useMemo } from 'react'

/** Hard cap on rendered diff lines. One <div> per line means an unbounded diff is an unbounded
 *  DOM: the 33k-line binary diff behind the 61 MB-session-log incident locked up the renderer.
 *  makeDiff now clamps at the source, but sessions saved *before* that fix still hold huge
 *  diffs, so the viewer refuses to render them too. */
const MAX_RENDERED_LINES = 800
/** Per-line cap — a minified bundle's diff is few lines but megabytes wide. */
const MAX_LINE_CHARS = 1_000

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-klenny-muted'
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return ''
}

/** Memoized, and the split cached on `diff`, so a large diff isn't re-split on every parent
 *  render while the surrounding message keeps streaming. */
export const DiffViewer = memo(function DiffViewer({ diff }: { diff: string }) {
  const { lines, omitted } = useMemo(() => {
    const all = diff.split('\n')
    const shown = all.slice(0, MAX_RENDERED_LINES)
    return { lines: shown, omitted: all.length - shown.length }
  }, [diff])
  return (
    <pre className="text-xs font-mono border border-klenny-border rounded overflow-auto max-h-64">
      {lines.map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …[${line.length - MAX_LINE_CHARS} more chars]` : line}
        </div>
      ))}
      {omitted > 0 && (
        <div className="diff-hunk">{`@@ ${omitted.toLocaleString()} more line${omitted === 1 ? '' : 's'} not shown @@`}</div>
      )}
    </pre>
  )
})
