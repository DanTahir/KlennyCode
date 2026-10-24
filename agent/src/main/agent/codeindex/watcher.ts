import { watch, type FSWatcher } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isGitignoreFile, isIgnoredPath, isInIgnoredDir } from './filewalker'

export interface WatcherCallbacks {
  /** A debounced batch of changed relative paths (deduplicated). The receiver decides change vs delete. */
  onBatch(relPaths: string[]): void
  /** A .gitignore changed: eligibility rules changed, so cached rules must be dropped and a rescan run. */
  onGitignoreChanged(): void
  /** Too many paths changed at once (branch switch, mass codegen). A full rescan is cheaper than per-file work. */
  onOverflow(): void
}

export interface WatcherOptions {
  /** Quiet period after the last event before a batch is emitted. */
  debounceMs?: number
  /** Upper bound on how long a continuously-busy tree can delay a batch. */
  maxWaitMs?: number
  /** Pending paths beyond this collapse into a single onOverflow() call. */
  maxPending?: number
}

const DEFAULTS: Required<WatcherOptions> = { debounceMs: 500, maxWaitMs: 3000, maxPending: 2000 }

/**
 * Recursive file watcher that keeps the codebase index fresh. Uses Node's built-in `fs.watch`
 * with `recursive: true` (native on Windows/macOS; on Linux emulated by Node itself since
 * Node 20) rather than chokidar.
 *
 * Events are filtered with the same rules as the full scan (`isIgnoredPath`) and coalesced into
 * debounced batches. Before this, each raw event started its own independent re-index, so a
 * tool writing many files (or a constantly rewritten log) ran many overlapping index updates.
 */
export class CodeIndexWatcher {
  private fsWatcher: FSWatcher | null = null
  private readonly pending = new Set<string>()
  private overflowed = false
  private gitignoreChanged = false
  private timer: NodeJS.Timeout | null = null
  private firstPendingAt = 0
  private readonly opts: Required<WatcherOptions>

  constructor(
    private readonly root: string,
    private readonly callbacks: WatcherCallbacks,
    opts: WatcherOptions = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  start(): void {
    if (this.fsWatcher) return
    try {
      this.fsWatcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        this.ingest(filename.toString())
      })
      this.fsWatcher.on('error', (e) => console.error('[codeindex] watcher error', e))
    } catch (e) {
      // fs.watch with recursive:true can throw on some platforms/filesystems (e.g. certain
      // network drives) — fail soft, the feature just degrades to "re-scan on next workspace
      // open" rather than crashing the whole app.
      console.error('CodeIndexWatcher: failed to start recursive watch', e)
    }
  }

  stop(): void {
    this.fsWatcher?.close()
    this.fsWatcher = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
    this.overflowed = false
    this.gitignoreChanged = false
  }

  /** Feeds one raw watcher filename (relative to root, any separator). Public for tests. */
  ingest(filename: string): void {
    const relPath = filename.split(sep).join('/').split('\\').join('/')
    if (isGitignoreFile(relPath)) {
      // .gitignore is a dot-file, so it must be checked before isIgnoredPath drops it.
      if (!isInIgnoredDir(relPath)) {
        this.gitignoreChanged = true
        this.schedule()
      }
      return
    }
    if (isIgnoredPath(relPath)) return
    if (this.overflowed) return
    this.pending.add(relPath)
    if (this.pending.size > this.opts.maxPending) {
      this.pending.clear()
      this.overflowed = true
    }
    this.schedule()
  }

  private schedule(): void {
    const now = Date.now()
    if (!this.timer) this.firstPendingAt = now
    else clearTimeout(this.timer)
    const waited = now - this.firstPendingAt
    const delay = Math.max(0, Math.min(this.opts.debounceMs, this.opts.maxWaitMs - waited))
    this.timer = setTimeout(() => this.flush(), delay)
    this.timer.unref?.()
  }

  private flush(): void {
    this.timer = null
    const gitignoreChanged = this.gitignoreChanged
    const overflowed = this.overflowed
    const paths = [...this.pending]
    this.pending.clear()
    this.gitignoreChanged = false
    this.overflowed = false
    try {
      if (gitignoreChanged) this.callbacks.onGitignoreChanged()
      if (overflowed) this.callbacks.onOverflow()
      else if (paths.length) this.callbacks.onBatch(paths)
    } catch (e) {
      console.error('[codeindex] watcher callback failed', e)
    }
  }
}

// Re-exported for callers that want to resolve an absolute path from a relative one emitted
// by the watcher (kept out of the class since it's a pure helper).
export function toAbsolute(root: string, relPath: string): string {
  return join(root, relPath)
}

export function toRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}
