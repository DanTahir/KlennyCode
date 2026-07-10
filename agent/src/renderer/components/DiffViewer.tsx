function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-klenny-muted'
  if (line.startsWith('@@')) return 'diff-hunk'
  if (line.startsWith('+')) return 'diff-add'
  if (line.startsWith('-')) return 'diff-del'
  return ''
}

export function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="text-xs font-mono border border-klenny-border rounded overflow-auto max-h-64">
      {lines.map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line}
        </div>
      ))}
    </pre>
  )
}
