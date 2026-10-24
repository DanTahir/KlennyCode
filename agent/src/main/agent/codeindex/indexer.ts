import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createEmbeddings } from '../../openrouter/client'
import { chunkFile } from './chunker'
import { listIndexableFiles, readIndexableFile } from './filewalker'
import { manifestChunkCount, type IndexManifest } from './manifest'
import type { VectorStore } from './vectorstore'

export interface IndexProgress {
  phase: 'scanning' | 'embedding' | 'idle' | 'error'
  filesTotal?: number
  filesDone?: number
  message?: string
}

export type ProgressCallback = (p: IndexProgress) => void

const EMBED_BATCH_SIZE = 64
/** During a full scan the manifest is checkpointed every this many changed files, so an
 *  interrupted scan (quit, crash) doesn't have to re-embed everything it already did. */
const MANIFEST_CHECKPOINT_EVERY = 25

/** Deterministic chunk id — same file+chunk index always maps to the same id across re-scans. */
function chunkId(relPath: string, index: number): string {
  return createHash('sha1').update(`${relPath}::${index}`).digest('hex')
}

/**
 * Caps how many chunks the index may hold. Unbounded growth is what produced the 532 MB Vectra
 * index; past the cap, files that would ADD chunks are skipped (and counted) instead of indexed,
 * while files that shrink or stay the same size are still updated.
 */
export interface ChunkBudget {
  /** Chunks currently stored (kept in sync by indexFile/removeFile). */
  total: number
  max: number
  /** Files skipped because indexing them would exceed `max`. */
  skippedFiles: number
}

export interface IndexContext {
  root: string
  /** The session's single in-memory manifest. Mutated in place; the caller persists it. */
  manifest: IndexManifest
  vectorStore: VectorStore
  apiKey: string
  embeddingsModel: string
  signal?: AbortSignal
  /** called with (promptTokens) each time an embeddings request completes, for spend tracking */
  onEmbeddingsUsage?: (promptTokens: number) => void
  budget?: ChunkBudget
}

export type FileIndexOutcome = 'indexed' | 'unchanged' | 'removed' | 'capped' | 'aborted'

/**
 * Re-indexes one file: chunks it, embeds only chunks whose hash changed, deletes chunk slots that
 * no longer exist, and records the new entries in `ctx.manifest`. Returns what happened.
 */
export async function indexFile(ctx: IndexContext, relPath: string): Promise<FileIndexOutcome> {
  const { root, manifest, vectorStore, apiKey, embeddingsModel, signal, onEmbeddingsUsage, budget } = ctx
  const content = await readIndexableFile(join(root, relPath))
  const previous = manifest.files[relPath] ?? []

  if (content === null) {
    // File became unreadable/binary since the last scan — drop any vectors we had for it.
    return (await removeFile(ctx, relPath)) ? 'removed' : 'unchanged'
  }

  const chunks = chunkFile(content)
  const delta = chunks.length - previous.length
  if (budget && delta > 0 && budget.total + delta > budget.max) {
    budget.skippedFiles++
    return 'capped'
  }

  // Delete ids for chunk slots that existed before but no longer do (file shrank).
  const staleIds = previous.filter((_, i) => i >= chunks.length).map((p) => p.id)

  // Only embed chunks whose hash actually changed (or is new) — this is what makes
  // re-scans and the live watcher cheap for large, mostly-unchanged codebases.
  const toEmbed: Array<{ index: number; text: string }> = []
  for (let i = 0; i < chunks.length; i++) {
    const prevEntry = previous[i]
    if (!prevEntry || prevEntry.hash !== chunks[i].hash) toEmbed.push({ index: i, text: chunks[i].text })
  }

  if (staleIds.length === 0 && toEmbed.length === 0 && manifest.files[relPath]) return 'unchanged'

  if (staleIds.length) await vectorStore.deleteByIds(staleIds)

  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH_SIZE) {
    if (signal?.aborted) return 'aborted'
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

  manifest.files[relPath] = chunks.map((c, i) => ({ id: chunkId(relPath, i), hash: c.hash }))
  if (budget) budget.total += delta
  return toEmbed.length > 0 ? 'indexed' : 'unchanged'
}

/** Removes a file's vectors and manifest entry. Returns false if it wasn't indexed. */
export async function removeFile(ctx: IndexContext, relPath: string): Promise<boolean> {
  const previous = ctx.manifest.files[relPath]
  if (!previous) return false
  await ctx.vectorStore.deleteByPath(relPath)
  delete ctx.manifest.files[relPath]
  if (ctx.budget) ctx.budget.total = Math.max(0, ctx.budget.total - previous.length)
  return true
}

export interface FullScanOptions extends IndexContext {
  onProgress?: ProgressCallback
  /** Persists `manifest`; called at checkpoints and at the end. */
  saveManifest: () => Promise<void>
}

export interface FullScanResult {
  filesTotal: number
  /** Files skipped because of the chunk budget. */
  cappedFiles: number
  /** Orphaned paths (vectors with no manifest entry) whose vectors were deleted. */
  prunedOrphans: number
  aborted: boolean
}

/**
 * Reconciles the manifest with what the store actually holds:
 *   - a manifest entry whose path has no vectors is forgotten, so the file gets re-embedded (this
 *     covers a fresh store next to an old manifest, e.g. after the Vectra → SQLite migration);
 *   - vectors whose path has no manifest entry are orphans (left by an interrupted run or the old
 *     concurrent-update race) and are deleted.
 * No-op for backends that cannot list paths (Pinecone).
 */
async function reconcileWithStore(manifest: IndexManifest, vectorStore: VectorStore): Promise<number> {
  const storePaths = await vectorStore.listPaths()
  if (!storePaths) return 0
  const inStore = new Set(storePaths)
  for (const path of Object.keys(manifest.files)) {
    if (!inStore.has(path)) delete manifest.files[path]
  }
  let pruned = 0
  for (const path of storePaths) {
    if (!manifest.files[path]) {
      await vectorStore.deleteByPath(path)
      pruned++
    }
  }
  return pruned
}

/**
 * Full or incremental scan of the workspace: reconciles the manifest with the store, walks
 * eligible files, embeds only changed chunks, and removes vectors for files that no longer
 * exist. Safe to call repeatedly (e.g. on every workspace open).
 */
export async function runFullScan(opts: FullScanOptions): Promise<FullScanResult> {
  const { root, manifest, vectorStore, onProgress, signal, saveManifest, budget } = opts

  onProgress?.({ phase: 'scanning' })
  const prunedOrphans = await reconcileWithStore(manifest, vectorStore)
  const files = await listIndexableFiles(root)
  if (signal?.aborted) return { filesTotal: files.length, cappedFiles: 0, prunedOrphans, aborted: true }

  const seenPaths = new Set(files)
  // Any previously-indexed file that no longer exists or is no longer eligible — drop its vectors.
  for (const oldPath of Object.keys(manifest.files)) {
    if (!seenPaths.has(oldPath)) {
      await vectorStore.deleteByPath(oldPath)
      delete manifest.files[oldPath]
    }
  }
  if (budget) {
    budget.total = manifestChunkCount(manifest)
    budget.skippedFiles = 0
  }

  let filesDone = 0
  let changedSinceCheckpoint = 0
  onProgress?.({ phase: 'embedding', filesTotal: files.length, filesDone: 0 })

  for (const relPath of files) {
    if (signal?.aborted) {
      await saveManifest()
      return { filesTotal: files.length, cappedFiles: budget?.skippedFiles ?? 0, prunedOrphans, aborted: true }
    }
    const outcome = await indexFile(opts, relPath)
    if (outcome === 'aborted') {
      await saveManifest()
      return { filesTotal: files.length, cappedFiles: budget?.skippedFiles ?? 0, prunedOrphans, aborted: true }
    }
    if (outcome === 'indexed' || outcome === 'removed') changedSinceCheckpoint++
    if (changedSinceCheckpoint >= MANIFEST_CHECKPOINT_EVERY) {
      await saveManifest()
      changedSinceCheckpoint = 0
    }
    filesDone++
    onProgress?.({ phase: 'embedding', filesTotal: files.length, filesDone })
  }

  await saveManifest()
  onProgress?.({ phase: 'idle', filesTotal: files.length, filesDone: files.length })
  return { filesTotal: files.length, cappedFiles: budget?.skippedFiles ?? 0, prunedOrphans, aborted: false }
}
