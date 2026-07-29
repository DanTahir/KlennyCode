import { useCallback, useEffect, useState } from 'react'
import type { AssistantMemoryPool, MemoryCompactionResult } from '@shared/types'

type Scope = 'project' | 'global' | 'soul' | 'assistant'

export function MemoryPanel() {
  const [scope, setScope] = useState<Scope>('project')
  const [content, setContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [compacting, setCompacting] = useState(false)
  const [compactResult, setCompactResult] = useState<MemoryCompactionResult | null>(null)
  const [compactError, setCompactError] = useState<string | null>(null)

  const [pool, setPool] = useState<AssistantMemoryPool | null>(null)
  const [poolBusy, setPoolBusy] = useState(false)

  const load = useCallback(async (s: Scope) => {
    if (s === 'assistant') {
      setPool(await window.klenny.listAssistantMemory())
      return
    }
    const value = s === 'soul' ? await window.klenny.readSoul() : await window.klenny.readMemory(s)
    setContent(value)
  }, [])

  useEffect(() => {
    setSavedAt(null)
    setError(null)
    setCompactResult(null)
    setCompactError(null)
    void load(scope)
  }, [scope, load])

  const handleCompactMemory = async () => {
    if (scope !== 'project' && scope !== 'global') return
    setCompacting(true)
    setCompactError(null)
    setCompactResult(null)
    try {
      const result = await window.klenny.compactMemory(scope)
      setCompactResult(result)
    } catch (err) {
      setCompactError(err instanceof Error ? err.message : String(err))
    } finally {
      setCompacting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      if (scope === 'soul') {
        await window.klenny.writeSoul(content)
      } else if (scope !== 'assistant') {
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

  const runPoolAction = async (fn: () => Promise<AssistantMemoryPool>) => {
    setPoolBusy(true)
    setError(null)
    try {
      setPool(await fn())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPoolBusy(false)
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
        <option value="assistant">Assistant windows (shared memory)</option>
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
      {(scope === 'project' || scope === 'global') && (
        <div className="border border-klenny-border rounded p-3 space-y-2">
          <div className="flex items-center gap-3">
            <button
              className="px-3 py-1 rounded border border-klenny-border text-sm disabled:opacity-50 flex items-center gap-2"
              onClick={() => void handleCompactMemory()}
              disabled={compacting}
              title="Uses the utility model to rewrite this scope's auto-memory notes into a smaller, cleaner set — pruning outdated/redundant notes. A backup of the originals is saved to disk first."
            >
              {compacting && (
                <span
                  className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin"
                  aria-hidden="true"
                />
              )}
              {compacting ? 'Compacting memory…' : 'Compact memory'}
              {!compacting && compactResult && !compactError && (
                <span className="text-green-500" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
            <span className="text-xs text-klenny-muted">
              Rewrites the agent's own auto-memory notes for this scope — doesn't touch{' '}
              <code>KLENNY.md</code> above.
            </span>
          </div>
          {compactError && <p className="text-xs text-red-400">Compaction failed: {compactError}</p>}
          {compactResult && !compactError && (
            <p className="text-xs text-klenny-muted">
              {compactResult.beforeCount === 0 ? (
                'No auto-memory notes to compact yet.'
              ) : (
                <>
                  {compactResult.beforeCount} notes ({compactResult.beforeChars.toLocaleString()} chars) →{' '}
                  {compactResult.afterCount} notes ({compactResult.afterChars.toLocaleString()} chars) across{' '}
                  {compactResult.passes} pass{compactResult.passes === 1 ? '' : 'es'}.
                  {compactResult.backupPath && ' Originals backed up to disk before replacing.'}
                </>
              )}
            </p>
          )}
        </div>
      )}
      {scope === 'assistant' ? (
        <AssistantMemoryViewer pool={pool} busy={poolBusy} error={error} runAction={runPoolAction} />
      ) : (
        <>
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
        </>
      )}
    </div>
  )
}

function AssistantMemoryViewer({
  pool,
  busy,
  error,
  runAction
}: {
  pool: AssistantMemoryPool | null
  busy: boolean
  error: string | null
  runAction: (fn: () => Promise<AssistantMemoryPool>) => Promise<void>
}) {
  if (!pool) return <p className="text-sm text-klenny-muted">Loading…</p>

  const slots = [...pool.slots].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className="space-y-4">
      <p className="text-sm text-klenny-muted">
        A single shared, auto-compacting memory pool that lets Assistant chat windows see (at a
        glance) what other Assistant windows have been up to. Klenny silently updates its own slot
        after each turn using the utility model; older slots get folded into the rollup below once
        the pool's token budget (set in Settings → Models & cost) fills up. This view is read-only
        aside from the delete/clear actions — Klenny itself is the only writer.
      </p>
      {error && <p className="text-xs text-red-400">{error}</p>}

      {pool.rollup && (
        <div className="border border-klenny-border rounded p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Rollup (older, compacted history)</h3>
            <button
              className="px-2 py-0.5 rounded border border-klenny-border text-xs disabled:opacity-50"
              disabled={busy}
              onClick={() => void runAction(() => window.klenny.clearAssistantMemoryRollup())}
            >
              Clear rollup
            </button>
          </div>
          <p className="text-xs text-klenny-muted whitespace-pre-wrap">{pool.rollup.content}</p>
          <p className="text-xs text-klenny-muted">
            ~{pool.rollup.tokenEstimate} tokens · updated {new Date(pool.rollup.updatedAt).toLocaleString()}
          </p>
        </div>
      )}

      {slots.length === 0 && !pool.rollup && (
        <p className="text-sm text-klenny-muted">No Assistant-window memory yet.</p>
      )}

      {slots.map((slot) => (
        <div key={slot.tabId} className="border border-klenny-border rounded p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">{slot.tabTitle || 'Untitled Assistant tab'}</h3>
            <button
              className="px-2 py-0.5 rounded border border-klenny-border text-xs disabled:opacity-50"
              disabled={busy}
              onClick={() => void runAction(() => window.klenny.deleteAssistantMemorySlot(slot.tabId))}
            >
              Delete
            </button>
          </div>
          <p className="text-xs text-klenny-muted whitespace-pre-wrap">{slot.content}</p>
          <p className="text-xs text-klenny-muted">
            ~{slot.tokenEstimate} tokens · updated {new Date(slot.updatedAt).toLocaleString()}
          </p>
        </div>
      ))}

      {(slots.length > 0 || pool.rollup) && (
        <button
          className="px-3 py-1 rounded border border-klenny-border text-sm disabled:opacity-50"
          disabled={busy}
          onClick={() => void runAction(() => window.klenny.clearAllAssistantMemory())}
        >
          Clear all assistant memory
        </button>
      )}
    </div>
  )
}
