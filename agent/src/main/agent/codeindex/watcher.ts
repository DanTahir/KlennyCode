import { watch, type FSWatcher } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isFileIndexable, ALWAYS_IGNORE_DIRS } from './filewalker'

export type FileChangeHandler = (relPath: string, kind: 'change' | 'delete') => void

/**
 * Lightweight recursive file watcher used to keep the codebase index fresh during a session.
 * Uses Node's built-in `fs.watch` with `recursive: true` (supported on Windows/macOS natively;
 * on Linux it's emulated by Node itself since Node 20) rather than pulling in chokidar or
 * Vectra's FolderWatcher — avoids an extra dependency for what's fundamentally "tell me when
 * something under this folder changed", and we already have our own ignore-list logic in
 * filewalker.ts that a generic watcher wouldn't know about.
 */
export class CodeIndexWatcher {
  private fsWatcher: FSWatcher | null = null
  private debounceTimers = new Map<string, NodeJS.Timeout>()

  constructor(
    private root: string,
    private onFileChanged: FileChangeHandler
  ) {}

  start(): void {
    if (this.fsWatcher) return
    try {
      this.fsWatcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return
        this.handleRawEvent(filename)
      })
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
    for (const t of this.debounceTimers.values()) clearTimeout(t)
    this.debounceTimers.clear()
  }

  private handleRawEvent(filename: string): void {
    const relPath = filename.split(sep).join('/')
    if (ALWAYS_IGNORE_DIRS.some((d) => relPath === d || relPath.startsWith(`${d}/`))) return

    // Debounce per-file: editors often emit several write events in quick succession for a
    // single logical save. 400ms is enough to coalesce those without feeling stale.
    const existing = this.debounceTimers.get(relPath)
    if (existing) clearTimeout(existing)
    this.debounceTimers.set(
      relPath,
      setTimeout(() => {
        this.debounceTimers.delete(relPath)
        void this.resolveAndEmit(relPath)
      }, 400)
    )
  }

  private async resolveAndEmit(relPath: string): Promise<void> {
    // fs.watch doesn't tell us whether this was a change or a delete — check eligibility
    // directly (same ignore/binary/size rules as the full scan, just scoped to one path)
    // rather than re-listing the whole workspace on every keystroke-adjacent save.
    try {
      const stillEligible = await isFileIndexable(this.root, relPath)
      this.onFileChanged(relPath, stillEligible ? 'change' : 'delete')
    } catch (e) {
      console.error('CodeIndexWatcher: failed to resolve change for', relPath, e)
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
