import type { ChatMessage, ToolCallBlock, ToolResultPayload } from '@shared/types'
import type { ChatMessage as ORMessage } from '../openrouter/client'

/**
 * Projects `tab.messages` (the persisted, UI-facing history) into the wire format sent to
 * OpenRouter. Kept dependency-free (no Electron imports) so it's directly unit-testable.
 *
 * `messages` here should already be the slice actually meant for the wire (i.e. with any
 * compacted-away prefix removed by the caller) — see `messagesForWire` — while `compactionSummary`,
 * if given, is injected as its own system message standing in for that removed prefix.
 *
 * `justCompacted` should be true only on the turn where compaction actually just ran (i.e.
 * `maybeCompact` returned `compacted: true` this request) — NOT on every subsequent turn that
 * happens to carry a `compactionSummary` forward. When true, an extra instruction is appended
 * telling the model to briefly tell the user compaction happened and then keep working in the
 * same turn. Without this, models tend to treat the injected summary system message as a natural
 * wrap-up point and end the turn with a text-only reply and no tool calls — which the orchestrator
 * can't distinguish from a genuinely finished task, so the agent silently stops mid-task right
 * when compaction fires. See "orchestrator/loop.ts" call site and project memory for the bug this
 * fixes.
 *
 * Deliberately does NOT take a "current time" note as a parameter: a live, per-request value
 * like that must never be folded into the system prompt or placed ahead of the conversation —
 * doing so poisons every cache breakpoint that comes after it (see applyCacheControl in
 * openrouter/caching.ts, which appends it as an uncached trailing part on the wire instead).
 */
export function toORMessages(
  messages: ChatMessage[],
  systemPrompt: string,
  compactionSummary?: string,
  justCompacted?: boolean
): ORMessage[] {
  const out: ORMessage[] = [{ role: 'system', content: systemPrompt }]
  if (compactionSummary) {
    let summaryMsg = `Summary of earlier conversation (older messages were omitted to save context):\n\n${compactionSummary}`
    if (justCompacted) {
      summaryMsg += `\n\nNote: this compaction just happened as part of your current turn, purely to manage context size — it is routine background maintenance, not a stopping point. In your next reply, briefly mention in one short sentence that you compacted/summarized earlier context to save space, then immediately continue the task exactly where you left off, using tool calls as needed. Do not end the turn with just that acknowledgment and no tool calls unless the task was already fully complete before compaction occurred.`
    }
    out.push({ role: 'system', content: summaryMsg })
  }
  const sentToolResults = new Set<string>()
  // Images returned by tool results (read_image today — see orchestrator/loop.ts) get queued
  // here rather than pushed immediately, and flushed as a single trailing synthetic user message
  // right after a whole run of consecutive tool messages. Anthropic (which OpenRouter must
  // translate to for Claude models) requires every tool_result for one assistant turn to live in
  // a single following user message — interleaving a user message between two tool messages from
  // the same batch of parallel tool calls would break that. A `tool`-role message's content can't
  // itself carry an image_url part on OpenAI-compatible APIs (only 'user' can), so this trailing
  // user message is the mechanism that actually lets the model see the image(s).
  let pendingToolImages: string[] = []
  const flushPendingToolImages = () => {
    if (!pendingToolImages.length) return
    out.push({
      role: 'user',
      content: pendingToolImages.map((dataUrl) => ({ type: 'image_url' as const, image_url: { url: dataUrl } }))
    })
    pendingToolImages = []
  }
  for (const m of messages) {
    if (m.role !== 'tool') flushPendingToolImages()
    if (m.role === 'user') {
      const textParts = m.blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text)
      const images = m.blocks.filter((b) => b.type === 'image') as Array<{ dataUrl: string }>
      if (images.length) {
        out.push({
          role: 'user',
          content: [
            ...textParts.map((t) => ({ type: 'text' as const, text: t })),
            ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } }))
          ]
        })
      } else {
        out.push({ role: 'user', content: textParts.join('\n') })
      }
    } else if (m.role === 'assistant') {
      const text = m.blocks
        .filter((b) => b.type === 'text' || b.type === 'thinking')
        .map((b) => (b as { text: string }).text)
        .join('')
      const tcs = [...new Map(
        (m.blocks.filter((b) => b.type === 'tool_call') as ToolCallBlock[]).map((tc) => [tc.id, tc])
      ).values()]
      if (tcs.length) {
        out.push({
          role: 'assistant',
          content: text || '',
          tool_calls: tcs.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.toolName, arguments: JSON.stringify(tc.args) }
          }))
        })
      } else if (text) {
        out.push({ role: 'assistant', content: text })
      }
    } else if (m.role === 'tool') {
      const tc = m.blocks.find((b) => b.type === 'tool_call') as ToolCallBlock | undefined
      if (tc?.result && !sentToolResults.has(tc.id)) {
        sentToolResults.add(tc.id)
        out.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: compactToolResult(tc.result)
        })
        const images = m.blocks.filter((b) => b.type === 'image') as Array<{ dataUrl: string }>
        pendingToolImages.push(...images.map((img) => img.dataUrl))
      }
    }
  }
  flushPendingToolImages()
  return out
}

/**
 * Returns the suffix of `messages` that still needs to be sent verbatim to the model — i.e.
 * everything after (and not including) `compactedThroughMessageId`. The prefix this drops is
 * assumed to already be represented by the tab's `compactionSummary`, injected separately by
 * `toORMessages`. `messages` itself (the UI-facing history) is never touched by this — it's a
 * read-only view used only when building the outgoing request.
 */
export function messagesForWire(messages: ChatMessage[], compactedThroughMessageId?: string): ChatMessage[] {
  if (!compactedThroughMessageId) return messages
  const idx = messages.findIndex((m) => m.id === compactedThroughMessageId)
  return idx === -1 ? messages : messages.slice(idx + 1)
}

export function compactToolResult(result: ToolResultPayload): string {
  const compact: ToolResultPayload = { ...result, data: result.data ? { ...(result.data as object) } : undefined }
  const data = compact.data as Record<string, unknown> | undefined
  if (data && Array.isArray(data.hits) && data.hits.length > 40) {
    const total = data.hits.length
    data.hits = data.hits.slice(0, 40)
    data.truncated = true
    data.totalHits = total
    compact.summary = `${compact.summary} (first 40 of ${total})`
  }
  if (data && Array.isArray(data.files) && data.files.length > 100) {
    data.files = (data.files as string[]).slice(0, 100)
    data.truncated = true
  }
  let json = JSON.stringify(compact)
  if (json.length > 40_000) json = `${json.slice(0, 40_000)}…[truncated]`
  return json
}
