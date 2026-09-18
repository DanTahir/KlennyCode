/**
 * Helpers for the live "writing…" status shown on a tool call whose arguments are still
 * streaming in from the model.
 *
 * WHY THIS EXISTS: a generation that emits a large `write_file`/`multi_write` payload spends many
 * seconds producing nothing but tool-call-argument JSON. openrouter/client.ts used to accumulate
 * those deltas silently and only yield the finished `tool_calls` chunk at the end of the stream,
 * so the UI showed no activity at all for the entire write and the app looked frozen. The client
 * now relays each fragment, the orchestrator turns it into a throttled `tool_call_writing` event,
 * and these pure helpers do the two cosmetic jobs that would otherwise be duplicated between the
 * main process (which owns the partial JSON) and the renderer (which owns the card).
 *
 * Everything here is deliberately pure, string-only and dependency-free so it can live in
 * `shared/` and be unit-tested without Electron, a provider, or a React tree.
 */

import type { ChatMessage } from './types'

/** Minimum gap between two `tool_call_writing` emissions for the SAME call. Purely an IPC-rate
 *  limiter: argument JSON streams fast enough that emitting per delta would push thousands of
 *  events per second through the renderer for a change no human can perceive. */
export const WRITING_EMIT_INTERVAL_MS = 120

/** Longest target label we'll show on a card before eliding. */
export const MAX_WRITING_LABEL_CHARS = 72

/**
 * Rate-limits the live writing updates for one tool call.
 *
 * `lastEmitAt === 0` means "never emitted for this call", which always emits immediately — the
 * whole point of the feature is that the card appears the moment the model starts writing, and a
 * short call may finish inside a single interval and never get a second chance.
 */
export function shouldEmitWriting(opts: {
  now: number
  lastEmitAt: number
  charsSoFar: number
  lastEmitChars: number
}): boolean {
  if (opts.lastEmitAt === 0) return true
  if (opts.charsSoFar === opts.lastEmitChars) return false
  return opts.now - opts.lastEmitAt >= WRITING_EMIT_INTERVAL_MS
}

/**
 * Human-readable size of the argument payload streamed so far.
 *
 * Counts UTF-16 characters of the raw JSON, not exact UTF-8 bytes — this is a progress indicator,
 * and the B/KB/MB suffix is close enough for text payloads while being far cheaper (and far more
 * honest about what we actually measured) than re-encoding the buffer on every update.
 */
export function formatArgSize(chars: number): string {
  if (!Number.isFinite(chars) || chars <= 0) return '0 B'
  if (chars < 1024) return `${Math.round(chars)} B`
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`
}

/** Keys whose values are the bulk payload of a call (file contents, edit fragments, prose). Their
 *  values are erased before scanning: a `content` string can itself contain `"path": "..."` (very
 *  common — this agent writes code about file paths), which would otherwise be picked up as the
 *  call's target and, for batch tools, inflate the file count. */
const LONG_VALUE_KEYS = [
  'content',
  'contents',
  'new_string',
  'old_string',
  'body',
  'text',
  'source',
  'code',
  'prompt',
  'summary',
  'description'
]

/** Generic fallback order for "what is this call about", most identifying first. */
const TARGET_KEYS = [
  'path',
  'file_path',
  'filename',
  'command',
  'pattern',
  'url',
  'query',
  'topic',
  'name',
  'action',
  'agent_type',
  'title',
  'to'
]

/** Per-tool overrides where the generic order would pick the less interesting field (e.g. a grep
 *  is identified by its pattern far more than by the directory it searches). */
const TOOL_KEY_PREFERENCE: Record<string, string[]> = {
  grep: ['pattern', 'path'],
  glob: ['pattern'],
  codebase_search: ['query'],
  run_command: ['command'],
  browser: ['url', 'action'],
  task: ['agent_type'],
  gmail_send_message: ['to'],
  web_search: ['query'],
  fetch_url: ['url']
}

/** Tools whose arguments carry a LIST of targets, so the label reports progress through the batch
 *  (count so far + the file currently being written) rather than a single path. */
const BATCH_TOOLS = new Set(['multi_write', 'multi_edit'])

const BATCH_PATH_KEYS = ['path', 'file_path', 'filename', 'file']

/**
 * Matches `"key": "value` and captures the value, tolerating BOTH an escaped-quote-containing
 * value and an unterminated one — the latter being the normal case here, since we are parsing JSON
 * that is still arriving. No trailing `"` is required by design.
 */
function valueMatcher(key: string): RegExp {
  return new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)', 'g')
}

function unescapeJsonish(s: string): string {
  return s
    .replace(/\\u[0-9a-fA-F]{4}/g, ' ')
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(["\\/])/g, '$1')
    // Anything still escaped (\b, \f, or a truncated escape at the very end of the stream).
    .replace(/\\./g, '')
    .replace(/\\$/, '')
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function truncateLabel(s: string): string {
  const clean = collapse(s)
  return clean.length > MAX_WRITING_LABEL_CHARS ? `${clean.slice(0, MAX_WRITING_LABEL_CHARS - 1)}…` : clean
}

function matchValues(raw: string, key: string): string[] {
  const re = valueMatcher(key)
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push(unescapeJsonish(m[1]))
    // Zero-length matches can't advance lastIndex on their own.
    if (m[0].length === 0) re.lastIndex++
  }
  return out
}

function stripLongValues(raw: string): string {
  let out = raw
  for (const key of LONG_VALUE_KEYS) {
    out = out.replace(valueMatcher(key), `"${key}":"`)
  }
  return out
}

/**
 * Removes any leftover renderer-only 'writing' placeholder blocks.
 *
 * A placeholder is normally replaced by the real tool-call block the instant the arguments finish
 * streaming, but a stream can end WITHOUT that ever happening: an aborted turn, a provider error
 * mid-JSON, or a generation that was cut off. Those placeholders would otherwise sit in the
 * transcript pulsing "writing…" forever, so the store prunes them at every stream end point.
 */
export function dropWritingPlaceholders(messages: ChatMessage[]): ChatMessage[] {
  let changed = false
  const out = messages.map((m) => {
    if (!m.blocks.some((b) => b.type === 'tool_call' && b.status === 'writing')) return m
    changed = true
    return { ...m, blocks: m.blocks.filter((b) => !(b.type === 'tool_call' && b.status === 'writing')) }
  })
  // Identity-preserving when there was nothing to drop — this runs on every turn_end/error, and
  // returning fresh arrays regardless would re-render every message in the tab for no reason.
  return changed ? out : messages
}

/**
 * Best-effort "what is this call about" label, derived from PARTIAL argument JSON.
 *
 * Returns undefined when nothing identifying has arrived yet (the card then shows just the tool
 * name and the size). Never throws and never attempts a real JSON.parse — the input is mid-stream
 * and therefore usually invalid JSON by construction.
 */
export function sniffWritingTarget(toolName: string, partialArgs: string): string | undefined {
  if (!partialArgs) return undefined
  const scan = stripLongValues(partialArgs)

  if (BATCH_TOOLS.has(toolName)) {
    const paths = BATCH_PATH_KEYS.flatMap((k) => matchValues(scan, k)).filter((p) => p.trim())
    if (!paths.length) return undefined
    const latest = truncateLabel(paths[paths.length - 1])
    return paths.length > 1 ? `${paths.length} files · ${latest}` : latest
  }

  const keys = [...(TOOL_KEY_PREFERENCE[toolName] ?? []), ...TARGET_KEYS]
  for (const key of keys) {
    const vals = matchValues(scan, key).filter((v) => v.trim())
    if (vals.length) return truncateLabel(vals[0])
  }
  return undefined
}
