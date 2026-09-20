import { createHash } from 'node:crypto'
import type { ChatMessage, ContentPart } from './client'

/**
 * Diagnostics for explicit prompt-cache breakpoints.
 *
 * Why this exists: the `[cache] request` log line used to report only WHICH message indices
 * carried a `cache_control` marker. That is not enough to debug a cache that fails to be read
 * back, because it cannot distinguish the two fundamentally different causes:
 *
 *   1. the prefix we sent this request differs byte-for-byte from the prefix the provider cached
 *      last request (our bug — nothing can hit a cache keyed on different bytes), versus
 *   2. the prefix was byte-identical and the provider still didn't report a read (upstream /
 *      provider-granularity behaviour, which no change on our side can fix).
 *
 * A cached entry is keyed on the ENTIRE prefix up to and including its breakpoint, so the only
 * meaningful fingerprint is of that whole prefix — not of the marked message alone. Each
 * breakpoint therefore gets three hashes, deliberately nested from strictest to loosest, so that
 * comparing two consecutive log lines at the same index localizes a divergence precisely:
 *
 *   - `wire`   — the prefix exactly as serialized to the provider, `cache_control` included.
 *   - `noMark` — same, with every `cache_control` marker stripped. Still distinguishes a bare
 *                string `content` from a single-element content-part array.
 *   - `text`   — fully shape-normalized: role, tool linkage and text only, so a string `content`
 *                and an equivalent `[{type:'text'}]` array hash identically.
 *
 * Reading the resulting ladder across two requests at the same index:
 *
 *   | text | noMark | wire | interpretation                                                    |
 *   |------|--------|------|-------------------------------------------------------------------|
 *   | diff | diff   | diff | real content changed upstream of the breakpoint — prefix poisoning |
 *   | same | diff   | diff | content identical, wire SHAPE flipped (string <-> parts array)     |
 *   | same | same   | diff | only the marker itself moved; prefix content was stable            |
 *   | same | same   | same | prefix fully stable — a cache miss here is upstream, not ours      |
 *
 * The second row is the one worth naming explicitly, because marking a breakpoint is what
 * converts a message's `content` from a bare string into a content-part array (see
 * `withCacheControlOnLastPart` in caching.ts), while `messages.ts` emits system/user/assistant/
 * tool content as bare strings. A message marked on one request and left unmarked two requests
 * later therefore changes shape without changing meaning.
 *
 * Kept free of Electron and of module state other than the request counter so it is directly
 * unit-testable.
 */
export interface BreakpointFingerprint {
  /** wire-message index carrying the marker */
  idx: number
  role: string
  /** whether this message's own `content` went out as a bare string or a content-part array */
  shape: 'str' | 'parts'
  /** which slot actually carries the marker. `call` is the normal case for an assistant turn
   *  with tool calls (it cuts after `tool_calls.arguments` rather than before — see `tryMark`),
   *  so seeing `part` on a tool-calling assistant message means the preference didn't apply. */
  markedOn: 'part' | 'call' | 'none'
  /** serialized length of the whole prefix through `idx`, a cheap proxy for cacheable size */
  chars: number
  wire: string
  noMark: string
  text: string
}

function sha8(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

/** Text-equivalent of a message's content, with the string/parts distinction normalized away.
 *  Non-text parts are reduced to a stable tag plus size: an image's base64 payload is enormous
 *  and hashing it adds nothing a length doesn't already capture. */
function partsText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => {
      // Structurally typed rather than narrowed off `ContentPart`: that union has exactly two
      // members, so narrowing both leaves the defensive fallback branch typed `never`.
      const part = p as { type?: string; text?: string; image_url?: { url?: string } }
      if (part.type === 'text') return part.text ?? ''
      if (part.type === 'image_url') return `[image_url:${part.image_url?.url?.length ?? 0}]`
      return `[${String(part.type)}]`
    })
    .join('\u0000')
}

/** Everything about a message that is real content rather than wire shape. `tool_calls` and
 *  `tool_call_id` are included because they are genuine payload the provider hashes too. */
function canonicalText(m: ChatMessage): string {
  // Marks are stripped first: `text` must answer "is the CONTENT the same?", so a cache_control
  // marker — which now normally rides a tool_call rather than a content part — must not move it,
  // or the interpretation table's "same text, different wire" row can never be observed.
  const withExtras = withoutMarks(m) as ChatMessage & { tool_call_id?: string; tool_calls?: unknown }
  const tcs = withExtras.tool_calls ? JSON.stringify(withExtras.tool_calls) : ''
  return [m.role, withExtras.tool_call_id ?? '', tcs, partsText(withExtras.content)].join('\u0001')
}

function withoutMarks(m: ChatMessage): ChatMessage {
  const withCalls = m as ChatMessage & { tool_calls?: Array<Record<string, unknown>> }
  let out = m
  if (withCalls.tool_calls?.some((c) => c.cache_control)) {
    out = {
      ...out,
      tool_calls: withCalls.tool_calls.map((c) => {
        const { cache_control: _dropped, ...rest } = c
        return rest
      })
    } as ChatMessage
  }
  if (typeof out.content === 'string' || !Array.isArray(out.content)) return out
  const parts = out.content.map((p) => {
    const { cache_control: _dropped, ...rest } = p as ContentPart & { cache_control?: unknown }
    return rest as ContentPart
  })
  return { ...out, content: parts }
}

/** Whether this message carries a `cache_control` marker, on a content part or on a tool call.
 *  Both placements are real breakpoints upstream (see `tryMark` in caching.ts), so a checker
 *  that only knew about content parts would under-report the very thing it exists to verify. */
export function hasBreakpoint(m: ChatMessage): boolean {
  if (Array.isArray(m.content) && m.content.some((p) => (p as { cache_control?: unknown }).cache_control)) return true
  const calls = (m as ChatMessage & { tool_calls?: Array<{ cache_control?: unknown }> }).tool_calls
  return Boolean(calls?.some((c) => c.cache_control))
}

/** Indices of every message carrying a `cache_control` marker, in ascending order. */
export function breakpointIndices(messages: ChatMessage[]): number[] {
  const idxs: number[] = []
  messages.forEach((m, i) => {
    if (hasBreakpoint(m)) idxs.push(i)
  })
  return idxs
}

/**
 * Fingerprints the cacheable prefix ending at each given index. Indices are processed in
 * ascending order and each fingerprint covers `messages[0..idx]` inclusive — mirroring how a
 * provider keys a cached block on its whole preceding prefix. Out-of-range indices are skipped
 * rather than throwing: this is diagnostics on a hot path and must never be able to fail a
 * request.
 */
export function fingerprintBreakpoints(messages: ChatMessage[], idxs: number[]): BreakpointFingerprint[] {
  const sorted = [...new Set(idxs)].filter((i) => i >= 0 && i < messages.length).sort((a, b) => a - b)
  const out: BreakpointFingerprint[] = []
  for (const idx of sorted) {
    const prefix = messages.slice(0, idx + 1)
    const wireJson = JSON.stringify(prefix)
    const m = messages[idx]
    const markedOnCall = Boolean(
      (m as ChatMessage & { tool_calls?: Array<{ cache_control?: unknown }> }).tool_calls?.some((c) => c.cache_control)
    )
    const markedOnPart = Array.isArray(m.content) && m.content.some((p) => (p as { cache_control?: unknown }).cache_control)
    out.push({
      idx,
      role: String(messages[idx].role),
      shape: typeof messages[idx].content === 'string' ? 'str' : 'parts',
      markedOn: markedOnCall ? 'call' : markedOnPart ? 'part' : 'none',
      chars: wireJson.length,
      wire: sha8(wireJson),
      noMark: sha8(JSON.stringify(prefix.map(withoutMarks))),
      text: sha8(prefix.map(canonicalText).join('\u0002'))
    })
  }
  return out
}

/** Compact single-line rendering, sized for a log file that gets read back by the agent itself. */
export function formatFingerprints(fps: BreakpointFingerprint[]): string {
  if (fps.length === 0) return 'none'
  return fps
    .map((f) => `#${f.idx}:${f.role}:${f.shape} on=${f.markedOn} chars=${f.chars} wire=${f.wire} noMark=${f.noMark} text=${f.text}`)
    .join(' | ')
}

/**
 * Monotonic per-process request id, used only to correlate a `[cache] request` line with the
 * `[cache] usage` line it belongs to. Without it the log is ambiguous the moment two requests
 * overlap — which is the normal case for `parallel_write` fan-out and for subagents, i.e. exactly
 * when caching behaviour is most interesting.
 */
let requestSeq = 0
export function nextRequestId(): string {
  requestSeq += 1
  return `r${requestSeq}`
}

/** Test-only: resets the request counter so id assertions don't depend on test ordering. */
export function resetRequestIds(): void {
  requestSeq = 0
}
