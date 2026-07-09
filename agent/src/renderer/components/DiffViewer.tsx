export function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split('\n')
  return (
    <pre className="text-xs font-mono border border-klenny-border rounded overflow-auto max-h-64">
      {lines.map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'diff-add'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'diff-del'
                : ''
          }
        >
          {line}
        </div>
      ))}
    </pre>
  )
}
