import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { PawprintListEntry } from '@shared/ipc'

/** "My Pawprints" management panel (plan v4, Phase 7): lists every known Pawprint with its
 *  instances, and lets the user open/close/delete an instance, toggle always-on-top on an open
 *  instance, and jump into a chat tab pre-seeded to ask Klenny to modify a given Pawprint. Package
 *  and domain approval always stays read-only here — changing either goes back through the
 *  approval-gated update_pawprint flow in chat, never a silent panel edit (see plan section 10). */
export function PawprintsPanel() {
  const { setTabs, setActiveTab, setPanel } = useAppStore()
  const [entries, setEntries] = useState<PawprintListEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busyInstanceIds, setBusyInstanceIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setEntries(await window.klenny.listPawprints())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Keeps the panel live when a Pawprint's own in-app UI creates/closes/deletes an instance (e.g.
  // a "new board" button inside the Kanban Pawprint calling requestNewInstance) — without this,
  // the registry change on disk was invisible to an already-mounted panel until the user
  // happened to click one of the panel's OWN buttons, which incidentally called refresh().
  useEffect(() => {
    return window.klenny.onPawprintListChanged(() => void refresh())
  }, [refresh])

  const withBusy = useCallback(
    async (instanceId: string, fn: () => Promise<void>) => {
      setBusyInstanceIds((prev) => new Set(prev).add(instanceId))
      try {
        await fn()
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyInstanceIds((prev) => {
          const next = new Set(prev)
          next.delete(instanceId)
          return next
        })
      }
    },
    [refresh]
  )

  const askKlennyToModify = useCallback(
    async (pawprintId: string, name: string) => {
      const tab = await window.klenny.createTab()
      setTabs(await window.klenny.listTabs())
      setActiveTab(tab.id)
      setPanel('chat')
      await window.klenny.sendMessage({
        tabId: tab.id,
        text: `Please read the source for my Pawprint "${name}" (id: ${pawprintId}) using read_pawprint_source, then help me modify it.`
      })
    },
    [setTabs, setActiveTab, setPanel]
  )

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-3xl space-y-4">
      <h2 className="text-xl font-semibold">My Pawprints 🐾</h2>
      <p className="text-sm text-klenny-muted">
        Sandboxed, agent-generated mini apps that run in their own windows. Ask Klenny in chat to create one — this panel
        manages the ones you already have.
      </p>
      {error && <div className="text-sm text-red-400 border border-red-900/50 rounded p-2">{error}</div>}
      {loading && entries.length === 0 && <p className="text-sm text-klenny-muted">Loading…</p>}
      {!loading && entries.length === 0 && (
        <p className="text-sm text-klenny-muted">No Pawprints yet. Ask Klenny in chat to create one for you.</p>
      )}
      <ul className="space-y-3">
        {entries.map((entry) => {
          const { manifest, instances, openInstanceIds } = entry
          const displayInstances = instances.length > 0 ? instances : [{ pawprintId: manifest.id, instanceId: manifest.id, alwaysOnTop: false, openOnLaunch: false, updatedAt: manifest.updatedAt }]
          return (
            <li key={manifest.id} className="border border-klenny-border rounded-lg p-4 bg-klenny-panel2 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-klenny-accent">{manifest.name}</div>
                  <div className="text-xs text-klenny-muted">{manifest.description}</div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    className="text-xs px-2 py-1 rounded bg-klenny-bg border border-klenny-border hover:border-klenny-accent"
                    onClick={() => void askKlennyToModify(manifest.id, manifest.name)}
                    title="Opens a new chat tab and asks Klenny to read this Pawprint's source before modifying it"
                  >
                    Ask Klenny to modify
                  </button>
                  <button
                    className="text-xs px-2 py-1 rounded bg-red-950 text-red-300 border border-red-900 hover:border-red-600"
                    onClick={() =>
                      void withBusy(manifest.id, async () => {
                        if (!window.confirm(`Delete Pawprint "${manifest.name}"? This removes its source, state, and manifest permanently.`)) return
                        await window.klenny.deletePawprint(manifest.id)
                      })
                    }
                    disabled={busyInstanceIds.has(manifest.id)}
                  >
                    Delete Pawprint
                  </button>
                </div>
              </div>

              <div className="text-xs text-klenny-muted space-y-1">
                <div>
                  <span className="font-medium">Approved packages:</span>{' '}
                  {manifest.packages.length === 0
                    ? 'none'
                    : manifest.packages.map((p) => `${p.name}@${p.version}`).join(', ')}
                </div>
                <div>
                  <span className="font-medium">Approved domains:</span>{' '}
                  {manifest.approvedDomains.length === 0 ? 'none (no network access)' : manifest.approvedDomains.join(', ')}
                </div>
              </div>

              <ul className="space-y-2">
                {displayInstances.map((inst) => {
                  const isOpen = openInstanceIds.includes(inst.instanceId)
                  const busy = busyInstanceIds.has(inst.instanceId)
                  return (
                    <li
                      key={inst.instanceId}
                      className="flex items-center justify-between gap-2 border border-klenny-border/60 rounded px-3 py-2"
                    >
                      <div className="text-xs">
                        <span className={isOpen ? 'text-green-400' : 'text-klenny-muted'}>{isOpen ? '● Open' : '○ Closed'}</span>
                        {inst.label && <span className="ml-2 text-klenny-muted">{inst.label}</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        {isOpen && (
                          <label className="flex items-center gap-1 text-xs text-klenny-muted">
                            <input
                              type="checkbox"
                              checked={inst.alwaysOnTop}
                              disabled={busy}
                              onChange={(e) =>
                                void withBusy(inst.instanceId, () => window.klenny.setPawprintAlwaysOnTop(inst.instanceId, e.target.checked))
                              }
                            />
                            Always on top
                          </label>
                        )}
                        <button
                          className="text-xs px-2 py-1 rounded bg-klenny-bg border border-klenny-border hover:border-klenny-accent disabled:opacity-50"
                          disabled={busy}
                          onClick={() =>
                            void withBusy(inst.instanceId, async () => {
                              if (isOpen) await window.klenny.closePawprint(inst.instanceId)
                              else await window.klenny.openPawprint(manifest.id, inst.instanceId)
                            })
                          }
                        >
                          {isOpen ? 'Close' : 'Open'}
                        </button>
                        <button
                          className="text-xs px-2 py-1 rounded bg-red-950 text-red-300 border border-red-900 hover:border-red-600 disabled:opacity-50"
                          disabled={busy}
                          title="Deletes this instance's saved data permanently. Closes its window first if open."
                          onClick={() =>
                            void withBusy(inst.instanceId, async () => {
                              const label = inst.label ? ` "${inst.label}"` : ''
                              if (!window.confirm(`Delete this instance${label}? Its saved data will be lost permanently.`)) return
                              await window.klenny.deletePawprintInstance(manifest.id, inst.instanceId)
                            })
                          }
                        >
                          Delete
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>

              {manifest.instanceModel === 'per-item' && (
                <button
                  className="text-xs px-2 py-1 rounded bg-klenny-bg border border-klenny-border hover:border-klenny-accent"
                  onClick={() => void withBusy(manifest.id, async () => { await window.klenny.openPawprint(manifest.id) })}
                >
                  + New instance
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
