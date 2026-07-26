import type { ToolResultPayload } from '@shared/types'
import { getWorkspace } from '../../workspace'
import { readTerminalLog } from '../../terminalLog'

/** Lets the agent see what's happened in the user's interactive terminal panel (see
 *  ../../terminal.ts), including across app restarts — the panel persists everything it prints
 *  to a per-project log file (../../terminalLog.ts) precisely so this is possible. Read-only. */
export async function readTerminalTool(args: { lines?: number }): Promise<ToolResultPayload> {
  const ws = getWorkspace()
  if (!ws) return { ok: false, summary: 'No workspace', error: 'no_workspace' }
  const lines = typeof args.lines === 'number' ? args.lines : 200
  const content = await readTerminalLog(ws, lines)
  if (!content.trim()) {
    return { ok: true, summary: 'Terminal log is empty — nothing has been run in the terminal panel yet', data: { content: '' } }
  }
  return { ok: true, summary: `Read last ${lines} line(s) of the terminal log`, data: { content } }
}
