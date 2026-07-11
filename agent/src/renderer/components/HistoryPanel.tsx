import { useEffect, useState } from 'react'
import type { ArchivedTabSession } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

function firstUserText(tab: ArchivedTabSession): string {
  for (const m of tab.messages) {
    if (m.role !== 'user') continue
    const text = m.blocks.find((b) => b.type === 'text')
    if (text && 'text' in text && text.text.trim()) return text.text.trim()
  }
  return '(no messages)'
}

export function HistoryPanel() {
  const { history, setHistory, setTabs, setActiveTab, setPanel } = useAppStore()
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void window.klenny.listHistory().then(setHistory)
  }, [])

  async function reopen(tabId: string) {
    setBusyId(tabId)
    try {
      const tab = await window.klenny.reopenHistory(tabId)
      if (tab) {
        setTabs(await window.klenny.listTabs())
        setActiveTab(tab.id)
        setPanel('chat')
      }
      setHistory(await window.klenny.listHistory())
    } finally {
      setBusyId(null)
    }
  }

  async function remove(tabId: string) {
    setBusyId(tabId)
    try {
      setHistory(await window.klenny.deleteHistory(tabId))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <h2 className="text-xl font-semibold">History</h2>
      <p className="text-klenny-muted text-sm">
        Chats are archived here when their tab is closed. Reopen one to keep going, or delete it for good.
      </p>
      {history.length === 0 && (
        <p className="text-klenny-muted text-sm">No closed chats yet — anything you close will show up here.</p>
      )}
      {history.map((tab) => (
        <div key={tab.id} className="border border-klenny-border rounded-lg p-4 bg-klenny-panel2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold truncate">{tab.title}</h3>
            <span className="text-xs text-klenny-muted shrink-0 ml-3">
              Closed {new Date(tab.closedAt).toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-klenny-muted truncate">{firstUserText(tab)}</p>
          <div className="flex gap-2 mt-3">
            <button
              className="px-3 py-1 rounded bg-klenny-accent text-black text-sm disabled:opacity-50"
              disabled={busyId === tab.id}
              onClick={() => void reopen(tab.id)}
            >
              Reopen
            </button>
            <button
              className="px-3 py-1 rounded border border-klenny-border text-sm text-klenny-muted hover:text-klenny-text disabled:opacity-50"
              disabled={busyId === tab.id}
              onClick={() => void remove(tab.id)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
