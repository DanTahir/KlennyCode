import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { format } from 'node:util'
import { userDataDir } from './dataDir'
import { stripAnsi } from './terminalLog'

/**
 * Persistent, ANSI-stripped capture of **Klenny Code's own main-process stdout/stderr** —
 * everything the app itself prints (`[cache]` request/usage lines, `[parallel_write]` diagnostics,
 * provider errors, unhandled rejections) — kept at `<userData>/process.log` and exposed to the
 * agent via the `read_app_log` tool (see agent/tools/appLog.ts).
 *
 * This is deliberately a SEPARATE log from terminalLog.ts, which captures the interactive
 * terminal *panel* (what the user typed and ran). The two answer different questions:
 *   - terminal.log  — "what did the USER run, and what did their command print?"  (per project)
 *   - process.log   — "what did the APP itself print while running?"             (app-global)
 * Merging them would interleave two unrelated streams and make neither readable; and the app's
 * own diagnostics aren't workspace-scoped (the OpenRouter client knows nothing about projects),
 * so they get one app-level file rather than a per-project one.
 *
 * Why this exists at all: diagnosing prompt-caching behaviour requires correlating the
 * `[cache] request … breakpointsAt=[…]` line with the `[cache] usage … cachedTokens=…` line that
 * follows it, across several consecutive turns. That signal is only observable in the app's own
 * stdout, which previously meant a human had to run a built binary from a terminal and paste the
 * output back in by hand. Capturing it to disk lets the agent verify its own caching fixes.
 *
 * ## Why BOTH the streams and the console methods are patched
 *
 * Wrapping `process.stdout`/`stderr.write` catches anything written to the fd directly. On
 * Node/Electron it also catches `console.log`, because Node's global console is constructed on
 * top of those two streams. That is NOT universally true, though: under Bun, `console.log` writes
 * to the fd without going through `process.stdout.write`, so a stream-only tee captures nothing
 * from it (found empirically — processLog.test.ts asserts it). Since essentially every diagnostic
 * this log exists to capture is a `console.log` call, depending on that runtime detail would be a
 * silent, total failure of the feature. So both layers are patched.
 *
 * Patching both raises the opposite risk — recording a line twice on Node, where a patched
 * `console.log` appends once and then its delegation writes through the patched stream. The
 * `suppressStreamCapture` flag brackets that delegation so the nested stream write is skipped,
 * making capture exactly-once on either runtime.
 *
 * Capture also happens BEFORE delegating, and any error from the original writer is swallowed,
 * because a **packaged** build has no attached console: an NSIS/GUI Windows app's underlying write
 * is a no-op or throws (EPIPE/EBADF). The on-disk log must be complete even when nothing is
 * visibly printed anywhere — the log, not a terminal scrollback, is the source of truth.
 */

/** Same "reasonable size" policy as terminalLog.ts — trimmed back to TRIM_TO_BYTES (keeping the
 *  most recent output) once it grows past MAX_LOG_BYTES, so it never grows unbounded. */
const MAX_LOG_BYTES = 2 * 1024 * 1024
const TRIM_TO_BYTES = 1.5 * 1024 * 1024

function processLogPath(): string {
  return join(userDataDir(), 'process.log')
}

// Single serialized write chain (mirrors terminalLog.ts): stdout can emit many small chunks in
// rapid succession, and appends must never interleave with each other or with a trim rewrite.
let writeChain: Promise<void> = Promise.resolve()
let knownSize: number | null = null

// Re-entrancy guard. If anything on the append path ever wrote to stdout/stderr itself (directly,
// or indirectly via a thrown error being reported), the tee would call itself recursively and
// blow the stack. Nothing here logs today; the guard makes that a safe property rather than a
// thing a future edit can silently break.
let capturing = false

// Set only while a patched console method delegates to the original. On Node/Electron that
// delegation writes through process.stdout/stderr, which the stream tee would otherwise capture a
// second time — see the doc comment's exactly-once note.
let suppressStreamCapture = false

function enqueue(task: () => Promise<void>): void {
  writeChain = writeChain.then(task).catch(() => {
    // Logging must never surface as an error to the app itself — best-effort only.
  })
}

async function sizeOf(path: string): Promise<number> {
  if (knownSize !== null) return knownSize
  try {
    const st = await stat(path)
    knownSize = st.size
  } catch {
    knownSize = 0
  }
  return knownSize
}

async function trimToFloor(path: string): Promise<void> {
  try {
    const buf = Buffer.from(await readFile(path, 'utf8'), 'utf8')
    if (buf.length <= MAX_LOG_BYTES) return
    const tailStart = buf.length - TRIM_TO_BYTES
    let cut = tailStart
    const newlineIdx = buf.indexOf(0x0a, tailStart) // cut on a line boundary, not mid-line
    if (newlineIdx !== -1) cut = newlineIdx + 1
    const marker = `[... earlier app output trimmed to keep this log under ${Math.round(MAX_LOG_BYTES / (1024 * 1024))}MB ...]\n`
    const trimmed = marker + buf.subarray(cut).toString('utf8')
    await writeFile(path, trimmed, 'utf8')
    knownSize = Buffer.byteLength(trimmed, 'utf8')
  } catch {
    // best-effort — a failed trim just means the log keeps growing until the next successful one
  }
}

/** Appends already-decoded text to the app log (ANSI-stripped), rotating if needed. Exported for
 *  the session marker below and for tests; the tee itself goes through `captureChunk`. */
export function appendProcessLog(text: string): void {
  const clean = stripAnsi(text)
  if (!clean) return
  enqueue(async () => {
    const path = processLogPath()
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, clean, 'utf8')
    knownSize = (await sizeOf(path)) + Buffer.byteLength(clean, 'utf8')
    if (knownSize > MAX_LOG_BYTES) await trimToFloor(path)
  })
}

/** Writes a `=== label ===` marker line, so the log reads as a sequence of app runs rather than
 *  one undifferentiated stream — the equivalent of terminalLog's session markers. Knowing where
 *  the current run starts is essential when comparing behaviour before/after a rebuild. */
export function appendProcessLogMarker(label: string): void {
  appendProcessLog(`\n=== ${label} ===\n`)
}

function captureChunk(chunk: unknown, encoding?: unknown): void {
  if (capturing || suppressStreamCapture) return
  capturing = true
  try {
    let text: string
    if (typeof chunk === 'string') {
      text = chunk
    } else if (Buffer.isBuffer(chunk)) {
      text = chunk.toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
    } else {
      return
    }
    appendProcessLog(text)
  } catch {
    // never let capture failure break the app's own output
  } finally {
    capturing = false
  }
}

type AnyWrite = (...args: unknown[]) => boolean
interface Patched {
  stream: 'stdout' | 'stderr'
  original: AnyWrite
}

let patched: Patched[] | null = null

function patch(streamName: 'stdout' | 'stderr'): Patched {
  const target = process[streamName] as unknown as { write: AnyWrite }
  const original = target.write.bind(target) as AnyWrite
  target.write = (...args: unknown[]): boolean => {
    // Capture FIRST, then delegate — see the module doc comment: in a packaged GUI build the
    // real write may be a no-op or throw, and the log must be complete regardless.
    captureChunk(args[0], args[1])
    try {
      return original(...args)
    } catch {
      // No console attached (packaged Windows build), closed pipe, etc. Report success so the
      // caller's logging doesn't itself become an error path.
      return true
    }
  }
  return { stream: streamName, original }
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug'
const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug']
type ConsoleFn = (...args: unknown[]) => void

let patchedConsole: Partial<Record<ConsoleMethod, ConsoleFn>> | null = null

function patchConsole(): void {
  if (patchedConsole) return
  const saved: Partial<Record<ConsoleMethod, ConsoleFn>> = {}
  const target = console as unknown as Record<string, ConsoleFn>
  for (const method of CONSOLE_METHODS) {
    const original = target[method].bind(console) as ConsoleFn
    saved[method] = original
    target[method] = (...args: unknown[]): void => {
      // `util.format` is exactly what Node's own console uses, so the captured line matches what
      // was printed (including %s/%d substitution and object inspection).
      appendProcessLog(`${(format as (...a: unknown[]) => string)(...args)}\n`)
      suppressStreamCapture = true
      try {
        original(...args)
      } catch {
        // an absent/closed console must never turn a log call into an error path
      } finally {
        suppressStreamCapture = false
      }
    }
  }
  patchedConsole = saved
}

function unpatchConsole(): void {
  if (!patchedConsole) return
  const target = console as unknown as Record<string, ConsoleFn>
  for (const method of CONSOLE_METHODS) {
    const original = patchedConsole[method]
    if (original) target[method] = original
  }
  patchedConsole = null
}

/**
 * Starts teeing this process's stdout/stderr (and the console methods that feed them) into the
 * app log. Idempotent — a second call is a no-op, so this can never install two layers of wrapper
 * (which would double every line).
 *
 * Call as early as possible in main-process startup: anything logged before this runs is not
 * captured.
 */
export function installProcessLogTee(): void {
  if (patched) return
  patched = [patch('stdout'), patch('stderr')]
  patchConsole()
}

/** Restores the original stream writers and console methods. Exported mainly so tests can avoid
 *  capturing the test runner's own output after they finish, but also a clean shutdown hook. */
export function uninstallProcessLogTee(): void {
  unpatchConsole()
  if (!patched) return
  for (const p of patched) {
    ;(process[p.stream] as unknown as { write: AnyWrite }).write = p.original
  }
  patched = null
}

/** Resolves once every append queued so far has landed on disk. `appendProcessLog` is
 *  fire-and-forget by design (the app must never block on log I/O), so tests need a
 *  deterministic wait instead of a fixed sleep. Also useful before reading the log back in the
 *  same tick as a write. */
export async function flushProcessLog(): Promise<void> {
  await writeChain
}

export interface ReadProcessLogOptions {
  /** number of most recent (post-filter) lines to return */
  lines?: number
  /** case-insensitive substring; only matching lines are returned. Deliberately a substring and
   *  not a regex — a model-supplied pattern that fails to compile would turn a diagnostic read
   *  into an error, and substring matching is what's actually wanted for tags like `[cache]`. */
  filter?: string
}

/** Reads the tail of the app's own process log. Returns '' when nothing has been captured yet. */
export async function readProcessLog(opts: ReadProcessLogOptions = {}): Promise<string> {
  const capped = Math.max(1, Math.min(opts.lines ?? 200, 5000))
  try {
    const content = await readFile(processLogPath(), 'utf8')
    let lines = content.split('\n')
    if (opts.filter) {
      const needle = opts.filter.toLowerCase()
      lines = lines.filter((l) => l.toLowerCase().includes(needle))
    }
    return lines.slice(-capped).join('\n')
  } catch {
    return ''
  }
}
