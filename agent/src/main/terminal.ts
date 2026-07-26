import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { nanoid } from 'nanoid'
import type { ShellInfo } from '@shared/types'
import { resolveShell } from './shells'
import { appendTerminalLog, appendTerminalLogMarker } from './terminalLog'

/** Extra args used to make a shell start interactively when launched under a PTY (mirrors what a
 *  normal double-click / terminal-app launch of that shell would use). Only posix shells need this
 *  on Windows (Git Bash defaults to non-interactive without it); cmd/powershell/wsl are already
 *  interactive by default when given no command to run. */
function interactiveArgs(shell: ShellInfo): string[] {
  if (shell.kind === 'posix' && process.platform === 'win32') return ['--login', '-i']
  return []
}

export interface TerminalSession {
  id: string
  pty: IPty
  shell: ShellInfo
  /** Workspace root this session was spawned in — used to route its output to the right
   *  per-project persistent terminal log (see terminalLog.ts) so the agent can read it back. */
  workspace: string
}

const sessions = new Map<string, TerminalSession>()

type DataListener = (id: string, data: string) => void
type ExitListener = (id: string, exitCode: number) => void

let onDataCb: DataListener | null = null
let onExitCb: ExitListener | null = null

export function setTerminalListeners(onData: DataListener, onExit: ExitListener): void {
  onDataCb = onData
  onExitCb = onExit
}

/** Spawns a new interactive PTY session using the given (or settings-selected) shell, rooted at cwd. */
export function createTerminal(opts: { shellId: string | null | undefined; cwd: string; cols: number; rows: number }): TerminalSession {
  const shell = resolveShell(opts.shellId)
  const id = nanoid()
  const proc = pty.spawn(shell.path, interactiveArgs(shell), {
    name: 'xterm-color',
    cols: Math.max(2, opts.cols || 80),
    rows: Math.max(2, opts.rows || 24),
    cwd: opts.cwd,
    env: process.env as Record<string, string>
  })

  const session: TerminalSession = { id, pty: proc, shell, workspace: opts.cwd }
  sessions.set(id, session)
  appendTerminalLogMarker(opts.cwd, `Terminal session started (${shell.name}) — ${new Date().toLocaleString()}`)

  proc.onData((data) => {
    appendTerminalLog(session.workspace, data)
    onDataCb?.(id, data)
  })
  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    appendTerminalLogMarker(session.workspace, `Terminal session ended (exit ${exitCode ?? 0})`)
    onExitCb?.(id, exitCode ?? 0)
  })

  return session
}

export function writeTerminal(id: string, data: string): void {
  sessions.get(id)?.pty.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = sessions.get(id)
  if (!session) return
  try {
    session.pty.resize(Math.max(2, cols || 80), Math.max(2, rows || 24))
  } catch {
    // resizing a dead pty can throw — safe to ignore
  }
}

export function disposeTerminal(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  sessions.delete(id)
  try {
    session.pty.kill()
  } catch {
    // already dead
  }
}

export function disposeAllTerminals(): void {
  for (const id of Array.from(sessions.keys())) disposeTerminal(id)
}
