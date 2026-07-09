import { useEffect, useState } from 'react'

export function MemoryPanel() {
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [content, setContent] = useState('')

  useEffect(() => {
    void window.klenny.readMemory(scope).then(setContent)
  }, [scope])

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl space-y-4">
      <h2 className="text-xl font-semibold">Memory</h2>
      <select className="px-2 py-1 bg-klenny-bg border border-klenny-border rounded" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'global')}>
        <option value="project">Project (KLENNY.md)</option>
        <option value="global">Global (~/.klenny/KLENNY.md)</option>
      </select>
      <textarea
        className="w-full min-h-[400px] font-mono text-sm px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <button
        className="px-3 py-1 rounded bg-klenny-accent text-black text-sm"
        onClick={() => void window.klenny.writeMemory(scope, content)}
      >
        Save memory
      </button>
    </div>
  )
}
