import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createEmbeddings } from '../../openrouter/client'
import { chunkFile } from './chunker'
import { listIndexableFiles, readIndexableFile } from './filewalker'
import { loadManifest, saveManifest, type IndexManifest } from './manifest'
import type { VectorStore } from './vectorstore'

export interface IndexProgress {
  phase: 'scanning' | 'embedding' | 'idle' | 'error'
  filesTotal?: number
  filesDone?: number
  message?: string
}

export type ProgressCallback = (p: IndexProgress) => void

const EMBED_BATCH_SIZE = 64

/** Deterministic chunk id — same file+chunk index always maps to the same id across re-scans. */
function chunkId(relPath: string, index: number): string {
  return createHash('sha1').update(`${relPath}::${index}`).digest('hex')
}

export interface IndexerDeps {
  root: string
  manifestPath: string
  vectorStore: VectorStore
  apiKey: string
  embeddingsModel: string
  onProgress?: ProgressCallback
  signal?: AbortSignal
  /** called with (promptTokens) each time an embeddings request completes, for spend tracking */
  onEmbeddingsUsage?: (promptTokens: number) => void
}

/**
 * Full or incremental scan of the workspace: walks eligible files, chunks each one,
 * skips chunks whose hash is unchanged since the last scan (tracked in the manifest),
 * embeds the rest in batches, upserts into the vector store, and removes vectors for
 * chunks/files that no longer exist. Safe to call repeatedly (e.g. on every workspace open).
 */
export async function runFullScan(deps: IndexerDeps): Promise<void> {
  const { root, manifestPath, vectorStore, apiKey, embeddingsModel, onProgress, signal, onEmbeddingsUsage } = deps
  const manifest = await loadManifest(manifestPath)

  onProgress?.({ phase: 'scanning' })
  const files = await listIndexableFiles(root)
  if (signal?.aborted) return

  const seenPaths = new Set(files)
  // Any previously-indexed file that no longer exists (deleted/moved) — drop its vectors.
  for (const oldPath of Object.keys(manifest.files)) {
    if (!seenPaths.has(oldPath)) {
      await vectorStore.deleteByPath(oldPath)
      delete manifest.files[oldPath]
    }
  }

  let filesDone = 0
  onProgress?.({ phase: 'embedding', filesTotal: files.length, filesDone: 0 })

  for (const relPath of files) {
    if (signal?.aborted) return
    await indexOneFile(root, relPath, manifest, vectorStore, apiKey, embeddingsModel, onEmbeddingsUsage, signal)
    filesDone++
    onProgress?.({ phase: 'embedding', filesTotal: files.length, filesDone })
  }

  manifest.embeddingsModel = embeddingsModel
  await saveManifest(manifestPath, manifest)
  onProgress?.({ phase: 'idle', filesTotal: files.length, filesDone: files.length })
}

/** Re-indexes a single file (used by the live watcher on file add/change). */
export async function indexSingleFile(
  root: string,
  manifestPath: string,
  relPath: string,
  vectorStore: VectorStore,
  apiKey: string,
  embeddingsModel: string,
  onEmbeddingsUsage?: (promptTokens: number) => void
): Promise<void> {
  const manifest = await loadManifest(manifestPath)
  await indexOneFile(root, relPath, manifest, vectorStore, apiKey, embeddingsModel, onEmbeddingsUsage)
  manifest.embeddingsModel = embeddingsModel
  await saveManifest(manifestPath, manifest)
}

/** Removes a single file's vectors (used by the live watcher on file delete). */
export async function removeSingleFile(manifestPath: string, relPath: string, vectorStore: VectorStore): Promise<void> {
  const manifest = await loadManifest(manifestPath)
  if (manifest.files[relPath]) {
    await vectorStore.deleteByPath(relPath)
    delete manifest.files[relPath]
    await saveManifest(manifestPath, manifest)
  }
}

async function indexOneFile(
  root: string,
  relPath: string,
  manifest: IndexManifest,
  vectorStore: VectorStore,
  apiKey: string,
  embeddingsModel: string,
  onEmbeddingsUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const abs = join(root, relPath)
  const content = await readIndexableFile(abs)
  const previous = manifest.files[relPath] ?? []

  if (content === null) {
    // File became unreadable/binary since the last scan — drop any vectors we had for it.
    if (previous.length) {
      await vectorStore.deleteByPath(relPath)
      delete manifest.files[relPath]
    }
    return
  }

  const chunks = chunkFile(content)
  const nextEntries: Array<{ id: string; hash: string }> = chunks.map((c, i) => ({ id: chunkId(relPath, i), hash: c.hash }))

  // Delete ids for chunk slots that existed before but no longer do (file shrank).
  const staleIds = previous.filter((_, i) => i >= chunks.length).map((p) => p.id)
  if (staleIds.length) await vectorStore.deleteByIds(staleIds)

  // Only embed chunks whose hash actually changed (or is new) — this is what makes
  // re-scans and the live watcher cheap for large, mostly-unchanged codebases.
  const toEmbed: Array<{ index: number; text: string }> = []
  for (let i = 0; i < chunks.length; i++) {
    const prevEntry = previous[i]
    if (!prevEntry || prevEntry.hash !== chunks[i].hash) {
      toEmbed.push({ index: i, text: chunks[i].text })
    }
  }

  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH_SIZE) {
    if (signal?.aborted) return
    const batch = toEmbed.slice(i, i + EMBED_BATCH_SIZE)
    const result = await createEmbeddings(apiKey, embeddingsModel, batch.map((b) => b.text), signal)
    onEmbeddingsUsage?.(result.promptTokens)
    const items = batch.map((b, j) => ({
      id: chunkId(relPath, b.index),
      vector: result.embeddings[j],
      metadata: {
        path: relPath,
        startLine: chunks[b.index].startLine,
        endLine: chunks[b.index].endLine,
        hash: chunks[b.index].hash
      }
    }))
    await vectorStore.upsertBatch(items)
  }

  manifest.files[relPath] = nextEntries
}
