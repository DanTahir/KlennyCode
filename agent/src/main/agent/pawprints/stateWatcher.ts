import { watch, mkdirSync, type FSWatcher } from 'node:fs'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { pawprintStateDir, pawprintStatePath } from './paths'

const DEBOUNCE_MS = 400
const RELOAD_RATE_LIMIT_MS = 2000
const PARSE_RETRY_DELAY_MS = 150

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

interface WatchedInstance {
  watcher: FSWatcher
  debounceTimer: NodeJS.Timeout | null
  lastSelfWriteHash: string | null
  lastLoadedContent: string | null
  lastReloadAt: number
}

/**
 * Per-open-instance state-file watcher. One instance of this class per currently-open Pawprint
 * window; started when the window opens, stopped when it closes (see windowManager.ts). Native
 * `fs.watch`, matching the existing codeindex/watcher.ts convention — no chokidar dependency.
 *
 * Self-write suppression is scoped specifically to the main process's own `setState` IPC path:
 * call `recordSelfWrite()` right after that handler finishes writing the file, and this watcher
 * will treat the next matching-content change as its own and skip the reload. Any other
 * main-process code path that writes state/*.json directly (none currently planned) is NOT
 * automatically covered by this suppression and would need its own recordSelfWrite() call.
 */
export class PawprintStateWatcher {
  private instances = new Map<string, WatchedInstance>()

  constructor(private onExternalChange: (pawprintId: string, instanceId: string, content: unknown) => void) {}

  start(pawprintId: string, instanceId: string, initialContent: string | null): void {
    const key = this.key(pawprintId, instanceId)
    if (this.instances.has(key)) return
    const dir = pawprintStateDir(pawprintId)
    const targetFilename = `${instanceId}.json`
    let watcher: FSWatcher
    try {
      // Watch the instance's state *directory*, not the state file itself. `fs.watch` throws
      // synchronously (ENOENT) if its target doesn't exist on disk yet, and a freshly-opened
      // Pawprint instance that has never called setState()/been written to has no `state/`
      // directory — let alone the per-instance `.json` file — on disk at all yet
      // (`writeStateFromMainProcess` only `mkdir`s it lazily, on first save; see storage.ts).
      // Ensuring the directory exists here (synchronously, since this is a one-time setup call
      // matching this method's existing synchronous signature) and watching it non-recursively
      // — filtering raw events down to this instance's own filename — sidesteps that ENOENT
      // entirely. It's also strictly more robust than watching the file directly: a later
      // delete+recreate of the file (e.g. the agent editing it via write_file, or the user
      // deleting it externally) never invalidates a directory-level watcher the way it can
      // invalidate a file-level one on some platforms.
      mkdirSync(dir, { recursive: true })
      watcher = watch(dir, (_event, filename) => {
        // A null filename is rare and platform-dependent and can't be filtered by name — fall
        // through rather than drop it; resolveChange's own content-hash comparison harmlessly
        // no-ops if it turns out this instance's file didn't actually change.
        if (filename !== null && filename !== targetFilename) return
        this.handleRawEvent(pawprintId, instanceId)
      })
    } catch (e) {
      console.error('PawprintStateWatcher: failed to watch', dir, e)
      return
    }
    this.instances.set(key, {
      watcher,
      debounceTimer: null,
      lastSelfWriteHash: initialContent ? hashContent(initialContent) : null,
      lastLoadedContent: initialContent,
      lastReloadAt: 0
    })
  }

  stop(pawprintId: string, instanceId: string): void {
    const key = this.key(pawprintId, instanceId)
    const entry = this.instances.get(key)
    if (!entry) return
    entry.watcher.close()
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    this.instances.delete(key)
  }

  /** Called by the setState IPC handler immediately after it finishes writing this instance's
   *  state file, so the watcher can recognize its own write and suppress a spurious reload. */
  recordSelfWrite(pawprintId: string, instanceId: string, writtenJson: string): void {
    const entry = this.instances.get(this.key(pawprintId, instanceId))
    if (!entry) return
    entry.lastSelfWriteHash = hashContent(writtenJson)
    entry.lastLoadedContent = writtenJson
  }

  private key(pawprintId: string, instanceId: string): string {
    return `${pawprintId}::${instanceId}`
  }

  private handleRawEvent(pawprintId: string, instanceId: string): void {
    const entry = this.instances.get(this.key(pawprintId, instanceId))
    if (!entry) return
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer)
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null
      void this.resolveChange(pawprintId, instanceId)
    }, DEBOUNCE_MS)
  }

  private async readWithRetry(path: string): Promise<{ raw: string; parsed: unknown } | 'missing' | 'invalid'> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await fs.readFile(path, 'utf8')
        try {
          return { raw, parsed: JSON.parse(raw) }
        } catch {
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, PARSE_RETRY_DELAY_MS))
            continue
          }
          return 'invalid'
        }
      } catch {
        return 'missing'
      }
    }
    return 'invalid'
  }

  private async resolveChange(pawprintId: string, instanceId: string): Promise<void> {
    const entry = this.instances.get(this.key(pawprintId, instanceId))
    if (!entry) return
    const path = pawprintStatePath(pawprintId, instanceId)
    const result = await this.readWithRetry(path)
    // Deleted state file, or still-invalid JSON after one retry (racing a non-atomic write):
    // silently skip — no error surfaced, a later write will naturally re-trigger the watcher.
    if (result === 'missing' || result === 'invalid') return

    const hash = hashContent(result.raw)
    if (entry.lastSelfWriteHash === hash) return // our own write via setState IPC — suppress
    if (entry.lastLoadedContent === result.raw) return // no-op: content unchanged since last load

    entry.lastLoadedContent = result.raw

    const now = Date.now()
    if (now - entry.lastReloadAt < RELOAD_RATE_LIMIT_MS) return // rate limit: ~1 reload / 2s
    entry.lastReloadAt = now

    this.onExternalChange(pawprintId, instanceId, result.parsed)
  }
}
