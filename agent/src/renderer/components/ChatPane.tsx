import { useState, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAppStore, getActiveTab } from '../store/useAppStore'
import { MessageBubble } from './MessageBubble'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { ModeToggle } from './ModeToggle'

export function ChatPane() {
  const { tabs, activeTabId, pendingActions, pendingQuestions, streamingTabIds, workspace, settings } = useAppStore()
  const tab = getActiveTab(tabs, activeTabId)
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const isStreaming = tab ? streamingTabIds.has(tab.id) : false

  const canSend = Boolean(workspace && settings?.hasApiKey)
  const blockReason = !settings?.hasApiKey
    ? 'Add your OpenRouter API key in Settings first.'
    : !workspace
      ? 'Open a project folder before chatting.'
      : null

  if (!tab) return null

  const tabPendingActions = pendingActions.filter((a) => a.tabId === tab.id)
  const tabQuestions = pendingQuestions.filter((q) => q.tabId === tab.id)

  const send = () => {
    if (!canSend) return
    if (!text.trim() && !images.length) return
    void window.klenny.sendMessage({ tabId: tab.id, text: text.trim() || 'See attached image(s).', images })
    setText('')
    setImages([])
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = () => setImages((prev) => [...prev, String(reader.result)])
        reader.readAsDataURL(file)
      }
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="px-4 py-2 border-b border-klenny-border flex items-center justify-between">
        <ModeToggle tabId={tab.id} mode={tab.mode} model={tab.model} />
        <div className="text-xs text-klenny-muted">
          ${tab.totalCostUsd.toFixed(4)} this chat
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tab.messages.length === 0 && (
          <div className="text-klenny-muted text-sm">
            Ask Klenny to explore, plan, or edit your project. Use Plan mode to research before making changes.
          </div>
        )}
        {tab.compactedThroughMessageId && (
          <div className="text-xs text-klenny-muted border border-klenny-border rounded px-2 py-1">
            Earlier messages were compacted to save context.
          </div>
        )}
        {tab.messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {tabPendingActions.map((a) => (
          <ApprovalCard key={a.id} action={a} />
        ))}
        {tabQuestions.map((q) => (
          <QuestionCard key={q.id} question={q} />
        ))}
      </div>

      <div className="border-t border-klenny-border p-3 bg-klenny-panel">
        {blockReason && (
          <div className="mb-2 text-xs text-amber-400/90 bg-amber-400/10 border border-amber-400/20 rounded px-2 py-1.5">
            {blockReason}
          </div>
        )}
        {images.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {images.map((img, i) => (
              <img key={i} src={img} alt="attachment" className="h-16 rounded border border-klenny-border" />
            ))}
          </div>
        )}
        <textarea
          className="w-full min-h-[80px] bg-klenny-bg border border-klenny-border rounded-md p-3 text-sm resize-y disabled:opacity-50"
          placeholder={canSend ? 'Message Klenny… (paste images supported)' : 'Complete setup above to start chatting'}
          value={text}
          disabled={!canSend}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className="flex justify-between mt-2">
          <div className="flex gap-2">
            <button
              className="text-xs px-2 py-1 border border-klenny-border rounded"
              onClick={() => fileRef.current?.click()}
            >
              Attach image
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                const reader = new FileReader()
                reader.onload = () => setImages((prev) => [...prev, String(reader.result)])
                reader.readAsDataURL(file)
              }}
            />
          </div>
          <div className="flex gap-2">
            {isStreaming && (
              <button
                className="px-3 py-1.5 rounded-md border border-klenny-border text-sm"
                onClick={() => void window.klenny.stopGeneration(tab.id)}
              >
                Stop
              </button>
            )}
            <button
              className="px-4 py-1.5 rounded-md bg-klenny-accent text-black text-sm font-medium disabled:opacity-50"
              disabled={isStreaming || !canSend}
              onClick={send}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
