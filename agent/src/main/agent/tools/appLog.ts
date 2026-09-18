import type { ToolResultPayload } from '@shared/types'
import { flushProcessLog, readProcessLog } from '../../processLog'

/**
 * Lets the agent read Klenny Code's **own** main-process stdout/stderr (see ../../processLog.ts)
 * — the app's internal diagnostics, as opposed to `read_terminal`, which shows the interactive
 * terminal panel (what the user ran). Read-only.
 *
 * The `filter` argument matters more than it looks: the app log is chatty, and the questions worth
 * asking of it are almost always tag-scoped (`[cache]`, `[parallel_write]`, `Error`). Filtering
 * server-side keeps an investigation from burning thousands of context tokens on unrelated lines.
 */
export async function readAppLogTool(args: { lines?: number; filter?: string }): Promise<ToolResultPayload> {
  const lines = typeof args.lines === 'number' ? args.lines : 200
  const rawFilter = typeof args.filter === 'string' ? args.filter.trim() : ''
  const filter = rawFilter || undefined

  // Any line printed moments ago may still be sitting in the serialized write queue, since
  // appends are fire-and-forget. Without this, reading right after triggering an action can
  // silently miss the very output being investigated.
  await flushProcessLog()
  const content = await readProcessLog({ lines, filter })

  if (!content.trim()) {
    return {
      ok: true,
      summary: filter
        ? `No lines matching "${filter}" in the app log yet`
        : 'App log is empty — nothing captured yet this run',
      data: { content: '', filter: filter ?? null }
    }
  }
  return {
    ok: true,
    summary: filter
      ? `Read last ${lines} app-log line(s) matching "${filter}"`
      : `Read last ${lines} line(s) of the app log`,
    data: { content, filter: filter ?? null }
  }
}
