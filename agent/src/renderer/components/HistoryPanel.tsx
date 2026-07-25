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

type Section = 'chats' | 'assistant'

export function HistoryPanel() {
  const { history, setHistory, assistantHistory, setAssistantHistory, setTabs, setActiveTab, setPanel } =
    useAppStore()
  const [section, setSection] = useState<Section>('chats')
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    void window.klenny.listHistory().then(setHistory)
    void window.klenny.listAssistantHistory().then(setAssistantHistory)
  }, [])

  async function reopen(tabId: string, isAssistant: boolean) {
    setBusyId(tabId)
    try {
      const tab = isAssistant
        ? await window.klenny.reopenAssistantHistory(tabId)
        : await window.klenny.reopenHistory(tabId)
      if (tab) {
        setTabs(await window.klenny.listTabs())
        setActiveTab(tab.id)
        setPanel('chat')
      }
      if (isAssistant) setAssistantHistory(await window.klenny.listAssistantHistory())
      else setHistory(await window.klenny.listHistory())
    } finally {
      setBusyId(null)
    }
  }

  async function remove(tabId: string, isAssistant: boolean) {
    setBusyId(tabId)
    try {
      if (isAssistant) setAssistantHistory(await window.klenny.deleteAssistantHistory(tabId))
      else setHistory(await window.klenny.deleteHistory(tabId))
    } finally {
      setBusyId(null)
    }
  }

  const list = section === 'chats' ? history : assistantHistory
  const isAssistant = section === 'assistant'

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">History</h2>
        <div className="flex rounded-md border border-klenny-border overflow-hidden text-sm">
          <button
            className={`px-3 py-1.5 ${section === 'chats' ? 'bg-klenny-accent text-black' : 'hover:bg-klenny-panel2'}`}
            onClick={() => setSection('chats')}
          >
            Chats
          </button>
          <button
            className={`px-3 py-1.5 ${section === 'assistant' ? 'bg-klenny-accent text-black' : 'hover:bg-klenny-panel2'}`}
            onClick={() => setSection('assistant')}
          >
            🐾 Assistant
          </button>
        </div>
      </div>
      <p className="text-klenny-muted text-sm">
        {isAssistant
          ? 'Assistant tabs are archived here when closed. Reopen one to keep going, or delete it for good.'
          : 'Chats are archived here when their tab is closed. Reopen one to keep going, or delete it for good.'}
      </p>
      {list.length === 0 && (
        <p className="text-klenny-muted text-sm">
          {isAssistant
            ? 'No closed Assistant tabs yet — anything you close will show up here.'
            : 'No closed chats yet — anything you close will show up here.'}
        </p>
      )}
      {list.map((tab) => (
        <div key={tab.id} className="border border-klenny-border rounded-lg p-4 bg-klenny-panel2">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold truncate">
              {isAssistant ? '🐾 ' : ''}
              {tab.title}
            </h3>
            <span className="text-xs text-klenny-muted shrink-0 ml-3">
              Closed {new Date(tab.closedAt).toLocaleString()}
            </span>
          </div>
          <p className="text-sm text-klenny-muted truncate">{firstUserText(tab)}</p>
          <div className="flex gap-2 mt-3">
            <button
              className="px-3 py-1 rounded bg-klenny-accent text-black text-sm disabled:opacity-50"
              disabled={busyId === tab.id}
              onClick={() => void reopen(tab.id, isAssistant)}
            >
              Reopen
            </button>
            <button
              className="px-3 py-1 rounded border border-klenny-border text-sm text-klenny-muted hover:text-klenny-text disabled:opacity-50"
              disabled={busyId === tab.id}
              onClick={() => void remove(tab.id, isAssistant)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
