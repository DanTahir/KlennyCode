import type { ChatMessage, ToolCallBlock } from '@shared/types'

/**
 * Tools whose results are eligible for superseded-result collapsing. `run_command` is
 * deliberately excluded — command output isn't idempotent even for an identical command
 * string (build/test logs differ run to run), so "the same resource was queried again"
 * doesn't mean the earlier result is safe to shorten.
 */
const COLLAPSIBLE_TOOLS = new Set(['read_file', 'grep', 'glob', 'fetch_url', 'write_file', 'edit_file', 'delete_file'])

/**
 * Maps a tool call to a "resource key" identifying what real-world resource it queried or
 * mutated (a file path, a specific search query, a URL). Two tool calls sharing a resource
 * key mean the later one supersedes the earlier one's result. Returns null for tools that
 * aren't eligible for collapsing at all.
 */
export function resourceKey(toolName: string, args: Record<string, unknown>): string | null {
  if (!COLLAPSIBLE_TOOLS.has(toolName)) return null
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return `file:${String(args.path ?? '')}`
    case 'grep':
      // path + pattern + glob + case_insensitive define the "same query" — a re-grep with a
      // different pattern (or different case-sensitivity, which can return different hits)
      // is a different resource, not a supersession of this one.
      return `grep:${String(args.path ?? '')}:${String(args.pattern ?? '')}:${String(args.glob ?? '')}:${args.case_insensitive ? 'i' : ''}`
    case 'glob':
      return `glob:${String(args.pattern ?? '')}:${String(args.cwd ?? '')}`
    case 'fetch_url':
      return `url:${String(args.url ?? '')}`
    default:
      return null
  }
}

/** Human-readable label for a resource key, used in the stub text shown to the model. */
function resourceLabel(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
    case 'delete_file':
      return `file (${String(args.path ?? '')})`
    case 'grep':
      return `search (${String(args.pattern ?? '')})`
    case 'glob':
      return `glob (${String(args.pattern ?? '')})`
    case 'fetch_url':
      return `URL (${String(args.url ?? '')})`
    default:
      return 'resource'
  }
}

export function buildSupersededStub(toolName: string, args: Record<string, unknown>): string {
  return `[superseded — a later ${toolName} read/modified the same ${resourceLabel(toolName, args)}; original result kept in history, shortened here to save tokens]`
}

/**
 * Given the full message list for a tab, detect all tool calls that should be marked as
 * superseded because a later tool call in the list shares their resource key. Returns the
 * list of `{ toolCallId, stub }` entries to annotate — pure and side-effect free so it's
 * independently testable. Callers are responsible for actually mutating and persisting the
 * change.
 *
 * Important: every tool call is represented by *two* `ToolCallBlock` copies in `tab.messages`
 * — one on the assistant message (with the real `args` the model sent, and the one the UI
 * renders) and one on a separate `tool`-role message (with `args: {}`, used only to build the
 * request/response pairing sent to the model). Resource keys must only ever be computed from
 * the assistant-message copy, since the tool-role copy's empty args would otherwise collapse
 * unrelated calls together under a bogus shared key. Returning just `toolCallId` (not
 * `messageId`) means callers can/should annotate *every* block sharing that id, since both
 * copies need `supersededSummary` set for the feature to work end-to-end (the tool-role copy
 * is what `toORMessages` actually reads from; the assistant copy is what the UI badge reads).
 *
 * Rules:
 * - Only `result.ok === true` tool calls ever get superseded (a failed result's diagnostic
 *   value often outlives "latest," and stubbing it risks the model repeating the mistake).
 * - A block that already has `supersededSummary` set is skipped (idempotent — never re-stub).
 * - Only the most recent earlier call per resource key remains a candidate; if there are three
 *   calls sharing a key, the first two both get annotated once the third appears.
 */
export function findNewlySupersededBlocks(messages: ChatMessage[]): Array<{ toolCallId: string; stub: string }> {
  const latestByKey = new Map<string, ToolCallBlock>()
  const results: Array<{ toolCallId: string; stub: string }> = []

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.blocks) {
      if (block.type !== 'tool_call') continue
      const tc = block as ToolCallBlock
      const key = resourceKey(tc.toolName, tc.args)
      if (!key) continue
      if (!tc.result || tc.result.ok !== true) continue

      const prior = latestByKey.get(key)
      if (prior && !prior.supersededSummary && prior.result?.ok === true) {
        results.push({ toolCallId: prior.id, stub: buildSupersededStub(prior.toolName, prior.args) })
      }
      latestByKey.set(key, tc)
    }
  }

  return results
}
