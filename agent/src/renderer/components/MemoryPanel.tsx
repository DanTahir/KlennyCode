import { useCallback, useEffect, useState } from 'react'

export function MemoryPanel() {
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (s: 'project' | 'global') => {
    const value = await window.klenny.readMemory(s)
    setContent(value)
  }, [])

  useEffect(() => {
    setSavedAt(null)
    setError(null)
    void load(scope)
  }, [scope, load])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await window.klenny.writeMemory(scope, content)
      // Re-read from disk to confirm the save actually persisted and to
      // keep the textarea in sync with what's on disk going forward.
      await load(scope)
      setSavedAt(Date.now())
    } catch (err) {
      // Previously this was fired with `void`, so a failed write (bad path,
      // permissions, etc.) would fail silently and the old content would
      // just reappear next time the panel was opened. Surface it instead.
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl space-y-4">
      <h2 className="text-xl font-semibold">Memory</h2>
      <p className="text-sm text-klenny-muted">
        Edits here apply only to the main <code>KLENNY.md</code> file for the selected scope.
        Auto-memory notes the agent writes for itself (via <code>write_memory</code>) are stored
        separately and aren't shown or editable in this box.
      </p>
      <select
        className="px-2 py-1 bg-klenny-bg border border-klenny-border rounded"
        value={scope}
        onChange={(e) => setScope(e.target.value as 'project' | 'global')}
      >
        <option value="project">Project (KLENNY.md)</option>
        <option value="global">Global (~/.klenny/KLENNY.md)</option>
      </select>
      <textarea
        className="w-full min-h-[400px] font-mono text-sm px-3 py-2 bg-klenny-bg border border-klenny-border rounded"
        value={content}
        onChange={(e) => {
          setContent(e.target.value)
          setSavedAt(null)
          setError(null)
        }}
      />
      <div className="flex items-center gap-3">
        <button
          className="px-3 py-1 rounded bg-klenny-accent text-black text-sm disabled:opacity-50"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? 'Saving…' : 'Save memory'}
        </button>
        {savedAt && <span className="text-xs text-klenny-muted">Saved</span>}
        {error && <span className="text-xs text-red-400">Save failed: {error}</span>}
      </div>
    </div>
  )
}
