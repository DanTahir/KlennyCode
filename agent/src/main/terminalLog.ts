import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { projectDataDir } from './dataDir'

/**
 * Persistent, ANSI-stripped log of everything the interactive terminal panel (see terminal.ts)
 * has printed for a given project, kept under `<userData>/projects/<id>/terminal.log` (same
 * per-project data dir used for plans/memory/index — see dataDir.ts) so it survives app restarts
 * without needing any .gitignore entry, and is exposed to the agent via the `read_terminal` tool
 * (see agent/tools/terminal.ts) so it can see what the user ran — including in past sessions —
 * without asking them to paste it. Mirrors the approach Cursor uses for terminal visibility.
 */

/** Strips ANSI/VT escape sequences (colors, cursor movement, OSC titles, etc.) so the on-disk
 *  log stays plain, readable text instead of being full of control codes. Equivalent to the
 *  well-known `ansi-regex` pattern — written inline to avoid adding a dependency for one regex. */
const ANSI_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)' +
    '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g'
)

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '')
}

/** "Reasonable size" cap per project, per the feature request — once the log exceeds this it's
 *  trimmed back down to TRIM_TO_BYTES (keeping the most recent output), so it never grows
 *  unbounded across long-running or many terminal sessions. */
const MAX_LOG_BYTES = 2 * 1024 * 1024
const TRIM_TO_BYTES = 1.5 * 1024 * 1024

function terminalLogPath(workspace: string): string {
  return join(projectDataDir(workspace), 'terminal.log')
}

// Serializes all log writes per workspace so rapid, concurrent PTY data events (a user typing
// or a chatty build command can emit many small chunks per second) can never interleave/race
// against each other or against a trim rewrite — each append awaits the previous one first.
const writeChains = new Map<string, Promise<void>>()
const knownSize = new Map<string, number>()

function enqueue(workspace: string, task: () => Promise<void>): void {
  const prev = writeChains.get(workspace) ?? Promise.resolve()
  const next = prev.then(task).catch(() => {
    // Logging must never surface as an error to the terminal session itself — best-effort only.
  })
  writeChains.set(workspace, next)
}

async function sizeOf(workspace: string, path: string): Promise<number> {
  const cached = knownSize.get(workspace)
  if (cached !== undefined) return cached
  try {
    const st = await stat(path)
    knownSize.set(workspace, st.size)
    return st.size
  } catch {
    knownSize.set(workspace, 0)
    return 0
  }
}

async function trimToFloor(workspace: string, path: string): Promise<void> {
  try {
    const content = await readFile(path, 'utf8')
    const buf = Buffer.from(content, 'utf8')
    if (buf.length <= MAX_LOG_BYTES) return
    const tailStart = buf.length - TRIM_TO_BYTES
    let cut = tailStart
    const newlineIdx = buf.indexOf(0x0a, tailStart) // cut on a line boundary, not mid-line
    if (newlineIdx !== -1) cut = newlineIdx + 1
    const marker = `[... earlier output trimmed to keep this log under ${Math.round(MAX_LOG_BYTES / (1024 * 1024))}MB ...]\n`
    const trimmed = marker + buf.subarray(cut).toString('utf8')
    await writeFile(path, trimmed, 'utf8')
    knownSize.set(workspace, Buffer.byteLength(trimmed, 'utf8'))
  } catch {
    // best-effort — a failed trim just means the log keeps growing until the next successful one
  }
}

/** Appends raw PTY output (ANSI-stripped) to this workspace's persistent terminal log, rotating
 *  it back down under MAX_LOG_BYTES if needed. Fire-and-forget from the caller's perspective —
 *  never throws — since logging must never interrupt or slow down the live terminal session. */
export function appendTerminalLog(workspace: string, data: string): void {
  const clean = stripAnsi(data)
  if (!clean) return
  enqueue(workspace, async () => {
    const path = terminalLogPath(workspace)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, clean, 'utf8')
    const size = (await sizeOf(workspace, path)) + Buffer.byteLength(clean, 'utf8')
    knownSize.set(workspace, size)
    if (size > MAX_LOG_BYTES) await trimToFloor(workspace, path)
  })
}

/** Writes a `=== label ===` marker line — used to bracket session start/end so the log reads
 *  like a sequence of runs rather than one undifferentiated stream. */
export function appendTerminalLogMarker(workspace: string, label: string): void {
  appendTerminalLog(workspace, `\n=== ${label} ===\n`)
}

/** Reads the last `lines` lines of this workspace's persistent terminal log, across app
 *  restarts and past sessions (up to whatever rotation has kept). Returns '' if none exists yet. */
export async function readTerminalLog(workspace: string, lines = 200): Promise<string> {
  const path = terminalLogPath(workspace)
  try {
    const content = await readFile(path, 'utf8')
    const capped = Math.max(1, Math.min(lines, 5000))
    return content.split('\n').slice(-capped).join('\n')
  } catch {
    return ''
  }
}
