import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Tracks, per indexed file, which chunk hashes are currently stored — so re-scans can skip
 * re-embedding unchanged chunks and know which stale chunk ids to delete when a file's
 * chunk boundaries shift. Also records which embeddings model built the index, since vectors
 * from different models live in incompatible vector spaces (see manager.ts's rebuild-on-mismatch).
 *
 * Vectra's local index has its own skip-if-unchanged upsert optimization internally, but that
 * only helps within a single upsert call — it doesn't tell us which *old* chunk ids to delete
 * when a file shrinks (fewer chunks than before). This manifest is what makes that safe for
 * both backends (local and Pinecone), since Pinecone has no such built-in tracking at all.
 */
export interface IndexManifest {
  embeddingsModel: string | null
  /** relative path -> chunk ids + hashes currently stored for that file */
  files: Record<string, Array<{ id: string; hash: string }>>
}

const EMPTY_MANIFEST: IndexManifest = { embeddingsModel: null, files: {} }

export async function loadManifest(path: string): Promise<IndexManifest> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<IndexManifest>
    return { ...EMPTY_MANIFEST, ...parsed }
  } catch {
    return { ...EMPTY_MANIFEST }
  }
}

export async function saveManifest(path: string, manifest: IndexManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(manifest, null, 2), 'utf8')
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
