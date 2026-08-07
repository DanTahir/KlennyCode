import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import {
  pawprintDir,
  pawprintManifestPath,
  pawprintSourceDir,
  pawprintSourceFile,
  pawprintStateDir,
  pawprintStatePath,
  pawprintsRegistryPath,
  pawprintsRootDir
} from './paths'
import type { PawprintManifest, PawprintRegistry } from './types'

// Per-path write queue: serializes concurrent `atomicWriteJson()` calls to the same destination.
// Without this, e.g. closing several Pawprint windows in quick succession (each window's
// `closed` handler fires an independent `persistInstanceRecordClosed()` write to the shared
// `pawprints-registry.json`) races on two levels: a lost-update race (each call reads the
// registry, mutates its own copy, and writes — a concurrent writer's change can be clobbered)
// and an OS-level race (two concurrent temp-file-then-rename calls targeting the same
// destination can collide; observed as `EPERM: operation not permitted` on Windows). Queuing by
// destination path preserves atomicity of each individual write while ensuring writes to the
// *same* file never overlap; writes to different files remain fully concurrent.
const writeQueues = new Map<string, Promise<void>>()

async function withWriteQueue(path: string, fn: () => Promise<void>): Promise<void> {
  const prior = writeQueues.get(path) ?? Promise.resolve()
  const next = prior.then(fn, fn) // run fn regardless of whether the prior write succeeded
  writeQueues.set(path, next.catch(() => {}))
  return next
}

/**
 * Atomic write: temp-file-then-rename, plus a rolling `.bak` of whatever was previously on disk.
 * Used for manifest.json and the cross-Pawprint registry — both small, infrequently-written,
 * security-relevant JSON files where a partial write must never be observable. NOT used for
 * per-instance state files (state/<instanceId>.json), which intentionally go through the plain
 * generic file tools (write_file/edit_file) so the agent can edit them directly (see writeGuard.ts
 * and stateWatcher.ts, which is written to tolerate non-atomic state writes).
 *
 * Serialized per destination path via `withWriteQueue()` — see its comment for why this matters.
 */
export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await withWriteQueue(path, () => atomicWriteJsonUnqueued(path, data))
}

/** The actual temp-file-then-rename-plus-.bak write, without the `withWriteQueue()` wrapper.
 *  Exported so a caller that has ALREADY entered the queue for this path (e.g.
 *  removeInstanceFromRegistry()'s own read-modify-write, which needs the read and the write to
 *  happen inside the same queued turn) can perform the write without queuing a second, nested
 *  turn under the same key — `withWriteQueue()` is not reentrant. Do not call this directly for
 *  a path you haven't already queued; that would reintroduce the exact race `atomicWriteJson()`
 *  exists to prevent. */
export async function atomicWriteJsonUnqueued(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const json = JSON.stringify(data, null, 2)
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    const prev = await fs.readFile(path).catch(() => null)
    if (prev) await fs.writeFile(`${path}.bak`, prev)
  } catch {
    // best-effort backup only
  }
  await fs.writeFile(tmp, json, 'utf8')
  await renameWithRetry(tmp, path)
}

/**
 * fs.rename with a few short retries on transient Windows lock errors (EPERM/EBUSY/EACCES).
 * Even with `withWriteQueue()` fully serializing writes to the same destination *within this
 * process*, a rapid-fire write (e.g. dozens of registry writes during a window drag/resize) can
 * still hit a rename that transiently fails because something OUTSIDE this process (antivirus/
 * Windows Defender real-time scanning, a search indexer, etc.) briefly holds a handle open on
 * the just-written destination file — a well-documented Windows-specific Node.js footgun, not a
 * bug in our own queuing. Retrying after a short delay resolves this in practice since the
 * external lock is momentary. If every retry fails, the original error propagates so callers
 * still see a real failure rather than one being silently swallowed.
 */
async function renameWithRetry(tmp: string, dest: string, attempts = 5, delayMs = 40): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await fs.rename(tmp, dest)
      return
    } catch (err) {
      const code = (err as { code?: string })?.code
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      if (!transient || attempt === attempts) throw err
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt))
    }
  }
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export async function readManifest(id: string): Promise<PawprintManifest | null> {
  return readJsonOrNull<PawprintManifest>(pawprintManifestPath(id))
}

export async function writeManifest(manifest: PawprintManifest): Promise<void> {
  await atomicWriteJson(pawprintManifestPath(manifest.id), manifest)
}

export async function writeSource(id: string, source: string): Promise<void> {
  await fs.mkdir(pawprintSourceDir(id), { recursive: true })
  const tmp = `${pawprintSourceFile(id)}.tmp-${process.pid}-${Date.now()}`
  await fs.writeFile(tmp, source, 'utf8')
  await fs.rename(tmp, pawprintSourceFile(id))
}

export async function readSource(id: string): Promise<string | null> {
  try {
    return await fs.readFile(pawprintSourceFile(id), 'utf8')
  } catch {
    return null
  }
}

export async function deletePawprint(id: string): Promise<void> {
  await fs.rm(pawprintDir(id), { recursive: true, force: true })
}

export async function listPawprintIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(pawprintsRootDir(), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

export async function listStateInstanceIds(id: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(pawprintStateDir(id))
    return entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

export async function readState(id: string, instanceId: string): Promise<unknown | null> {
  return readJsonOrNull<unknown>(pawprintStatePath(id, instanceId))
}

/** Deletes one instance's persisted state file (used by instance deletion — NOT by
 *  deletePawprint(), which removes the whole per-Pawprint directory tree in one shot instead).
 *  Tolerant of the file already being missing (e.g. an instance that was opened but never
 *  called setState()). */
export async function deleteState(id: string, instanceId: string): Promise<void> {
  await fs.rm(pawprintStatePath(id, instanceId), { force: true })
}

/** Used only by the main process's own setState IPC handler (see stateWatcher.ts for the
 *  self-write-suppression hash this feeds). Direct agent writes to state/*.json go through the
 *  generic write_file/edit_file tools instead, guarded by writeGuard.ts — not this function. */
export async function writeStateFromMainProcess(id: string, instanceId: string, data: unknown): Promise<string> {
  await fs.mkdir(pawprintStateDir(id), { recursive: true })
  const json = JSON.stringify(data, null, 2)
  await fs.writeFile(pawprintStatePath(id, instanceId), json, 'utf8')
  return json
}

export async function readRegistry(): Promise<PawprintRegistry> {
  const reg = await readJsonOrNull<PawprintRegistry>(pawprintsRegistryPath())
  return reg ?? { instances: [] }
}

export async function writeRegistry(registry: PawprintRegistry): Promise<void> {
  await atomicWriteJson(pawprintsRegistryPath(), registry)
}

/** Removes one instance's record from the cross-Pawprint registry, if present. Serialized
 *  through the same per-path write queue as every other registry write (see withWriteQueue()
 *  above) so this can never race a concurrent persistInstanceRecord()/persistInstanceRecordClosed()
 *  write to the same registry.json — both read-modify-write against the queue, not raw disk. */
export async function removeInstanceFromRegistry(pawprintId: string, instanceId: string): Promise<void> {
  await withWriteQueue(pawprintsRegistryPath(), async () => {
    const registry = await readRegistry()
    const next = registry.instances.filter((i) => !(i.pawprintId === pawprintId && i.instanceId === instanceId))
    if (next.length === registry.instances.length) return // nothing to remove
    await atomicWriteJsonUnqueued(pawprintsRegistryPath(), { instances: next })
  })
}
