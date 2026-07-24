import { useCallback, useEffect, useState } from 'react'

type Scope = 'project' | 'global' | 'soul'

export function MemoryPanel() {
  const [scope, setScope] = useState<Scope>('project')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (s: Scope) => {
    const value = s === 'soul' ? await window.klenny.readSoul() : await window.klenny.readMemory(s)
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
      if (scope === 'soul') {
        await window.klenny.writeSoul(content)
      } else {
        await window.klenny.writeMemory(scope, content)
      }
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

  const handleRestoreDefault = async () => {
    setRestoring(true)
    setError(null)
    try {
      const defaultContent = await window.klenny.resetSoul()
      setContent(defaultContent)
      setSavedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoring(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl space-y-4">
      <h2 className="text-xl font-semibold">Memory</h2>
      <p className="text-sm text-klenny-muted">
        Edits here apply only to the main <code>KLENNY.md</code> file for the selected scope, or to{' '}
        <code>SOUL.md</code> (personality) when that scope is selected. Auto-memory notes the agent
        writes for itself (via <code>write_memory</code>) are stored separately and aren't shown or
        editable in this box.
      </p>
      <select
        className="px-2 py-1 bg-klenny-bg border border-klenny-border rounded"
        value={scope}
        onChange={(e) => setScope(e.target.value as Scope)}
      >
        <option value="project">Project (KLENNY.md)</option>
        <option value="global">Global (~/.klenny/KLENNY.md)</option>
        <option value="soul">Personality (~/.klenny/SOUL.md)</option>
      </select>
      {scope === 'soul' && (
        <p className="text-sm text-klenny-muted">
          This is Klenny's "soul" — who the agent is and how it expresses itself in chat. It's
          global across every project. Edit it to change the tone, or clear it out entirely for a
          plain, personality-free voice. A hardcoded set of guardrails (not shown here, and not
          editable) always keeps personality from affecting reasoning, plans, or code quality —
          no matter what you write here.
        </p>
      )}
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
        {scope === 'soul' && (
          <button
            className="px-3 py-1 rounded border border-klenny-border text-sm disabled:opacity-50"
            onClick={() => void handleRestoreDefault()}
            disabled={restoring}
            title="Overwrite SOUL.md with Klenny's built-in default personality"
          >
            {restoring ? 'Restoring…' : 'Restore default personality'}
          </button>
        )}
        {savedAt && <span className="text-xs text-klenny-muted">Saved</span>}
        {error && <span className="text-xs text-red-400">Save failed: {error}</span>}
      </div>
    </div>
  )
}
