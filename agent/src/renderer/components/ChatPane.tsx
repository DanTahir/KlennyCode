import { useState, useRef, useMemo, useEffect } from 'react'
import type { PendingDocument } from '@shared/types'
import { useAppStore, getActiveTab } from '../store/useAppStore'
import { MessageBubble } from './MessageBubble'
import { ApprovalCard } from './ApprovalCard'
import { QuestionCard } from './QuestionCard'
import { ModeToggle } from './ModeToggle'
import { ApprovalModeSelect } from './ApprovalModeSelect'
import { AttachMenu } from './AttachMenu'
import { PendingAttachmentRow } from './PendingAttachmentRow'
import { describeModelWaiting, modelWaitingDetail } from '@shared/modelWaiting'

// Mirrors MAX_DOCUMENT_FILE_BYTES in agent/documents/extract.ts — checked client-side too so an
// oversized file is rejected instantly instead of only after a wasted base64-encode + IPC round trip.
const MAX_DOCUMENT_FILE_BYTES = 8 * 1024 * 1024
const DOCUMENT_ACCEPT = '.md,.txt,.docx'

/** Windowed history: rendering thousands of messages at once makes every update (and the initial
 *  tab switch) expensive, so only the most recent messages are mounted until the user asks. */
const INITIAL_RENDER_COUNT = 60
const RENDER_STEP = 60

/** Lets the browser skip layout/paint for off-screen messages in a long transcript. */
const OFFSCREEN_SKIP_STYLE: React.CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 160px' }

export function ChatPane() {
  // One selector per field, each returning an existing reference or a primitive, so a streamed
  // token only re-renders this pane when something it actually shows has changed.
  const tab = useAppStore((s) => getActiveTab(s.tabs, s.activeTabId))
  const tabId = tab?.id ?? null
  const isStreaming = useAppStore((s) => (tabId ? s.streamingTabIds.has(tabId) : false))
  const isCompacting = useAppStore((s) => (tabId ? s.compactingTabIds.has(tabId) : false))
  const pendingActions = useAppStore((s) => s.pendingActions)
  const pendingQuestions = useAppStore((s) => s.pendingQuestions)
  const workspace = useAppStore((s) => s.workspace)
  const settings = useAppStore((s) => s.settings)
  const tabError = useAppStore((s) => (tabId ? s.tabErrors[tabId] : undefined))
  const paused = useAppStore((s) => (tabId ? s.pausedTabs[tabId] : undefined))
  const tabWaiting = useAppStore((s) => (tabId ? s.modelWaiting[tabId] : undefined))
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER_COUNT)
  const [text, setText] = useState('')
  const [images, setImages] = useState<string[]>([])
  const [documents, setDocuments] = useState<PendingDocument[]>([])
  const [documentError, setDocumentError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const docFileRef = useRef<HTMLInputElement>(null)
  const waiting = isStreaming && !isCompacting ? tabWaiting : undefined

  // A different tab starts with a fresh window rather than inheriting the previous tab's depth.
  useEffect(() => {
    setRenderCount(INITIAL_RENDER_COUNT)
  }, [tabId])

  const tabPendingActions = useMemo(
    () => (tabId ? pendingActions.filter((a) => a.tabId === tabId) : []),
    [pendingActions, tabId]
  )
  const tabQuestions = useMemo(
    () => (tabId ? pendingQuestions.filter((q) => q.tabId === tabId) : []),
    [pendingQuestions, tabId]
  )

  const messages = tab?.messages
  const compactedThroughMessageId = tab?.compactedThroughMessageId
  const visibleMessages = useMemo(() => (messages ?? []).filter((m) => m.role !== 'tool'), [messages])

  // compactedThroughMessageId marks the cutoff in the FULL message list (which includes tool
  // messages), so it may point at a message that's filtered out of visibleMessages above. Resolve
  // it to the last visible message at or before that cutoff so the banner lands in the right spot
  // instead of silently never matching.
  const compactionBoundaryMessageId = useMemo(() => {
    if (!messages || !compactedThroughMessageId) return undefined
    const cutoffIdx = messages.findIndex((m) => m.id === compactedThroughMessageId)
    if (cutoffIdx < 0) return undefined
    for (let i = cutoffIdx; i >= 0; i--) {
      if (messages[i].role !== 'tool') return messages[i].id
    }
    return undefined
  }, [messages, compactedThroughMessageId])

  const canSend = Boolean(workspace && settings?.hasApiKey)
  const blockReason = !settings?.hasApiKey
    ? 'Add your OpenRouter API key in Settings first.'
    : !workspace
      ? 'Open a project folder before chatting.'
      : null

  if (!tab) return null

  const hiddenCount = Math.max(0, visibleMessages.length - renderCount)
  const renderedMessages = hiddenCount > 0 ? visibleMessages.slice(hiddenCount) : visibleMessages

  const send = () => {
    if (!canSend) return
    if (!text.trim() && !images.length && !documents.length) return
    const fallbackText = images.length && documents.length
      ? 'See attached image(s) and document(s).'
      : documents.length
        ? 'See attached document(s).'
        : 'See attached image(s).'
    void window.klenny.sendMessage({ tabId: tab.id, text: text.trim() || fallbackText, images, documents })
    setText('')
    setImages([])
    setDocuments([])
    setDocumentError(null)
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

  const attachDocument = (file: File) => {
    setDocumentError(null)
    if (file.size > MAX_DOCUMENT_FILE_BYTES) {
      setDocumentError(
        `"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max size is ${MAX_DOCUMENT_FILE_BYTES / 1024 / 1024} MB.`
      )
      return
    }
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = String(reader.result)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const result = await window.klenny.extractDocument({ filename: file.name, mimeType: file.type || 'application/octet-stream', base64 })
      if (result.ok) {
        setDocuments((prev) => [...prev, result])
      } else {
        setDocumentError(result.error)
      }
    }
    reader.onerror = () => setDocumentError(`Failed to read "${file.name}".`)
    reader.readAsDataURL(file)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="px-4 py-2 border-b border-klenny-border flex items-center justify-between">
        <ModeToggle tabId={tab.id} mode={tab.mode} model={tab.model} kind={tab.kind} />
        <div className="text-xs text-klenny-muted">
          ${tab.totalCostUsd.toFixed(4)} this chat
          {(tab.totalSavingsUsd ?? 0) > 0 && (
            <span className="text-green-400"> (saved ${(tab.totalSavingsUsd ?? 0).toFixed(4)} via caching)</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {tab.messages.length === 0 && (
          <div className="text-klenny-muted text-sm">
            {tab.kind === 'assistant'
              ? 'Ask Klenny Code to schedule a task, check your email, or post to Discord.'
              : 'Ask Klenny Code to explore, plan, or edit your project. Use Plan mode to research before making changes.'}
          </div>
        )}
        {tabError && (
          <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/30 rounded px-3 py-2">
            {tabError}
          </div>
        )}
        {hiddenCount > 0 && (
          <button
            type="button"
            className="text-xs text-klenny-muted hover:text-klenny-accent underline-offset-2 hover:underline"
            onClick={() => setRenderCount((c) => c + RENDER_STEP)}
          >
            Show {Math.min(RENDER_STEP, hiddenCount)} earlier messages
          </button>
        )}
        {renderedMessages.map((m, i) => (
          // The last two messages are the live/streaming ones; skipping their layout would cause
          // visible size jumps as the placeholder intrinsic size is swapped for the real one.
          <div key={m.id} style={i < renderedMessages.length - 2 ? OFFSCREEN_SKIP_STYLE : undefined}>
            <MessageBubble message={m} />
            {compactionBoundaryMessageId === m.id && (
              <div className="text-xs text-klenny-muted border border-klenny-border rounded px-2 py-1 mt-4">
                Messages above this point were summarized for the AI to save context — it now sees a summary of them
                instead of the originals.
              </div>
            )}
          </div>
        ))}
        {isCompacting && (
          <div className="flex items-center gap-2.5 text-xs text-klenny-muted border border-klenny-border rounded px-3 py-2">
            <span
              className="inline-block w-3.5 h-3.5 shrink-0 rounded-full border-2 border-klenny-accent border-t-transparent animate-spin"
              aria-hidden="true"
            />
            <span>
              <span className="text-klenny-text animate-pulse">Compacting context…</span>{' '}
              summarizing earlier messages so the conversation keeps fitting in the model's context window. This
              takes a few seconds.
            </span>
          </div>
        )}
        {waiting && (
          <div
            className="flex items-center gap-2.5 text-xs text-klenny-muted border border-amber-400/30 bg-amber-400/5 rounded px-3 py-2"
            role="status"
          >
            <span
              className="inline-block w-3.5 h-3.5 shrink-0 rounded-full border-2 border-amber-400 border-t-transparent animate-spin"
              aria-hidden="true"
            />
            <span>
              <span className="text-klenny-text animate-pulse">{describeModelWaiting(waiting.info)}</span>{' '}
              {modelWaitingDetail(waiting.info)}
            </span>
          </div>
        )}
        {tabPendingActions.map((a) => (
          <ApprovalCard key={a.id} action={a} />
        ))}
        {tabQuestions.map((q) => (
          <QuestionCard key={q.id} question={q} />
        ))}
        {paused && (
          <div className="text-sm bg-amber-400/10 border border-amber-400/30 rounded px-3 py-2 flex items-center justify-between gap-3">
            <span>
              {paused.reason === 'checkpoint'
                ? `Paused at a checkpoint after ${paused.stepsCompleted} steps — click Continue to keep going.`
                : `Paused after hitting the safety limit (${paused.stepsCompleted} steps) — click Continue if you want it to keep going.`}
            </span>
            <button
              className="px-3 py-1 rounded-md bg-klenny-accent text-black text-sm font-medium shrink-0"
              onClick={() => void window.klenny.continueTurn(tab.id)}
            >
              Continue
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-klenny-border p-3 bg-klenny-panel">
        {blockReason && (
          <div className="mb-2 text-xs text-amber-400/90 bg-amber-400/10 border border-amber-400/20 rounded px-2 py-1.5">
            {blockReason}
          </div>
        )}
        {documentError && (
          <div className="mb-2 text-xs text-red-400 bg-red-400/10 border border-red-400/30 rounded px-2 py-1.5">
            {documentError}
          </div>
        )}
        <PendingAttachmentRow
          images={images}
          documents={documents}
          onRemoveImage={(i) => setImages((prev) => prev.filter((_, idx) => idx !== i))}
          onRemoveDocument={(i) => setDocuments((prev) => prev.filter((_, idx) => idx !== i))}
        />
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
            <AttachMenu
              disabled={!canSend}
              onAttachImage={() => fileRef.current?.click()}
              onAttachDocument={() => docFileRef.current?.click()}
            />
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
                e.target.value = ''
              }}
            />
            <input
              ref={docFileRef}
              type="file"
              accept={DOCUMENT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                attachDocument(file)
                e.target.value = ''
              }}
            />
          </div>
          <div className="flex gap-2 items-center">
            {settings && (
              <ApprovalModeSelect
                tabId={tab.id}
                mode={tab.approvalMode}
                globalMode={settings.approvalMode}
                hideCommand={tab.kind === 'assistant'}
              />
            )}
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
