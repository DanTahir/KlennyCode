import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Tracks, per indexed file, which chunk hashes are currently stored — so re-scans can skip
 * re-embedding unchanged chunks and know which stale chunk ids to delete when a file's
 * chunk boundaries shift. Also records which embeddings model built the index, since vectors
 * from different models live in incompatible vector spaces (see manager.ts's rebuild-on-mismatch).
 *
 * The manager keeps ONE in-memory manifest per indexing session and every index operation runs
 * on a serial queue, so there is a single writer. (Previously each watcher event loaded and saved
 * its own copy concurrently, and lost updates left vectors in the store that the manifest no
 * longer knew about.)
 */
export interface IndexManifest {
  embeddingsModel: string | null
  /** relative path -> chunk ids + hashes currently stored for that file */
  files: Record<string, Array<{ id: string; hash: string }>>
}

function emptyManifest(): IndexManifest {
  // A fresh object each time: a shared `files` default would be mutated across sessions.
  return { embeddingsModel: null, files: {} }
}

export async function loadManifest(path: string): Promise<IndexManifest> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<IndexManifest>
    return {
      embeddingsModel: typeof parsed.embeddingsModel === 'string' ? parsed.embeddingsModel : null,
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files : {}
    }
  } catch {
    return emptyManifest()
  }
}

/** Atomic (temp file + rename), so a crash mid-write can't leave a truncated manifest. */
export async function saveManifest(path: string, manifest: IndexManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(manifest), 'utf8')
  await rename(tmp, path)
}

/** Total chunk entries recorded in the manifest. Matches the store's count once reconciled. */
export function manifestChunkCount(manifest: IndexManifest): number {
  let n = 0
  for (const entries of Object.values(manifest.files)) n += entries.length
  return n
}

/**
 * True when the manifest was built with a different embeddings model than the one currently
 * configured — meaning its stored vectors live in an incompatible vector space and must be
 * discarded (full rebuild) rather than incrementally updated. `null` (never indexed yet) is
 * never a mismatch — there's nothing to invalidate.
 */
export function embeddingsModelMismatch(manifest: IndexManifest, currentModel: string): boolean {
  return manifest.embeddingsModel !== null && manifest.embeddingsModel !== currentModel
}
