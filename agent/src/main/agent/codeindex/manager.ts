import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { readFile, readdir, unlink, rm } from 'node:fs/promises'
import type { AppSettings, IndexStatus, ModelInfo } from '@shared/types'
import { createEmbeddings } from '../../openrouter/client'
import { getApiKey, getPineconeKey } from '../../settings'
import { projectDataDir, userDataDir } from '../../dataDir'
import { trackDailySpend } from '../spend'
import { invalidateGitignoreCache, isFileIndexable } from './filewalker'
import { runFullScan, indexFile, removeFile, type ChunkBudget, type IndexContext } from './indexer'
import { loadManifest, saveManifest, embeddingsModelMismatch, type IndexManifest } from './manifest'
import { PineconeVectorStore, type VectorStore } from './vectorstore'
import { WorkerVectorStore } from './workerStore'
import { CodeIndexWatcher } from './watcher'

const __dirname = dirname(fileURLToPath(import.meta.url))

const INDEX_DIR_NAME = 'index'
const MANIFEST_FILE_NAME = 'manifest.json'
const SQLITE_FILE_NAME = 'vectors.sqlite'
/** Where the removed Vectra backend kept its index.json (see cleanupLegacyVectraIndexes). */
const LEGACY_VECTRA_DIR_NAME = 'local'
/** Built by electron-vite as a separate main-process entry (see electron.vite.config.ts). */
const WORKER_FILE_NAME = 'codeindexWorker.js'

/** Upper bound on stored chunks (see ChunkBudget). At 4096 dims a chunk is ~16 KB of vector data. */
const MAX_INDEXED_CHUNKS = 50_000
/** A file is re-embedded at most once per this interval; extra changes are coalesced into one
 *  deferred update. Stops a constantly rewritten file from turning into a stream of embedding calls. */
const HOT_FILE_MIN_INTERVAL_MS = 30_000
/** Live updates pause after this many consecutive failures (e.g. revoked key, provider outage)
 *  instead of failing, logging and retrying on every save. */
const MAX_CONSECUTIVE_FAILURES = 5
/** Delay before a rescan requested by a .gitignore change or watcher overflow. */
const RESCAN_DELAY_MS = 2000
/** Minimum spacing of 'embedding' progress events sent to the renderer during a scan. */
const PROGRESS_EMIT_INTERVAL_MS = 200
/** stopIndexing waits at most this long for the in-flight queue task to observe the abort. */
const STOP_TIMEOUT_MS = 5000

/** The codebase semantic-search index lives under `<userData>/projects/<id>/index`, not inside the project tree. */
function indexDir(root: string): string {
  return join(projectDataDir(root), INDEX_DIR_NAME)
}

function manifestPath(root: string): string {
  return join(indexDir(root), MANIFEST_FILE_NAME)
}

/**
 * Runs async tasks strictly one at a time, in submission order. Full scans, live updates and
 * rescans all go through one queue per session, so the in-memory manifest has a single writer.
 */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

interface SessionState {
  root: string
  vectorStore: VectorStore
  watcher: CodeIndexWatcher
  abortController: AbortController
  status: IndexStatus
  manifest: IndexManifest
  manifestPath: string
  queue: SerialQueue
  apiKey: string
  embeddingsModel: string
  onEmbeddingsUsage: (promptTokens: number) => void
  budget: ChunkBudget
  /** Paths reported by the watcher and not yet processed. */
  pendingPaths: Set<string>
  drainQueued: boolean
  rescanQueued: boolean
  /** When each path was last actually re-embedded (hot-file backoff). */
  lastEmbeddedAt: Map<string, number>
  deferTimers: Map<string, NodeJS.Timeout>
  consecutiveFailures: number
  liveUpdatesPaused: boolean
  lastProgressEmitAt: number
}

let session: SessionState | null = null
let onStatusChange: ((status: IndexStatus) => void) | null = null

export function setOnStatusChange(cb: (status: IndexStatus) => void): void {
  onStatusChange = cb
}

function isLive(s: SessionState): boolean {
  return session === s && !s.abortController.signal.aborted
}

function emitStatus(s: SessionState, patch: Partial<IndexStatus>): void {
  if (session !== s) return
  s.status = { ...s.status, ...patch }
  onStatusChange?.(s.status)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function workerScriptPath(): string {
  return join(__dirname, WORKER_FILE_NAME)
}

async function buildVectorStore(root: string, settings: AppSettings): Promise<VectorStore> {
  if (settings.vectorStoreBackend === 'pinecone') {
    const key = await getPineconeKey()
    if (!key) throw new Error('Pinecone selected as vector store backend but no Pinecone API key is set.')
    if (!settings.pineconeIndexName) throw new Error('Pinecone selected as vector store backend but no index name is set.')
    return new PineconeVectorStore(key, settings.pineconeIndexName)
  }
  return new WorkerVectorStore(workerScriptPath(), join(indexDir(root), SQLITE_FILE_NAME))
}

/** Finds the priced ModelInfo for the configured embeddings model, used for spend tracking. */
function findModelInfo(models: ModelInfo[], modelId: string): ModelInfo | undefined {
  return models.find((m) => m.id === modelId)
}

function indexContext(s: SessionState): IndexContext {
  return {
    root: s.root,
    manifest: s.manifest,
    vectorStore: s.vectorStore,
    apiKey: s.apiKey,
    embeddingsModel: s.embeddingsModel,
    signal: s.abortController.signal,
    onEmbeddingsUsage: s.onEmbeddingsUsage,
    budget: s.budget
  }
}

function capMessage(cappedFiles: number): string | undefined {
  if (cappedFiles === 0) return undefined
  return (
    `Index size cap reached (${MAX_INDEXED_CHUNKS.toLocaleString()} chunks): ${cappedFiles} file(s) were not indexed. ` +
    'Add .gitignore rules for generated or vendored code to shrink the index.'
  )
}

/**
 * Deletes the on-disk index left by the removed Vectra backend: `<project>/index/local`, holding
 * one `index.json` with every vector serialized as JSON (532 MB for one real project). Nothing
 * reads it anymore. Its sibling manifest.json is kept: the next scan reconciles it against the
 * new, empty SQLite store and re-embeds what is needed.
 */
async function removeLegacyVectraIndex(root: string): Promise<boolean> {
  const dir = join(indexDir(root), LEGACY_VECTRA_DIR_NAME)
  if (!existsSync(dir)) return false
  await rm(dir, { recursive: true, force: true })
  console.log(`[codeindex] removed legacy Vectra index at ${dir}`)
  return true
}

/** Startup sweep: removes legacy Vectra index dirs for every known project. Best-effort. */
export async function cleanupLegacyVectraIndexes(): Promise<void> {
  const projectsDir = join(userDataDir(), 'projects')
  let entries: string[]
  try {
    entries = await readdir(projectsDir)
  } catch {
    return
  }
  let removed = 0
  for (const id of entries) {
    const dir = join(projectsDir, id, INDEX_DIR_NAME, LEGACY_VECTRA_DIR_NAME)
    if (!existsSync(dir)) continue
    try {
      await rm(dir, { recursive: true, force: true })
      removed++
    } catch (e) {
      console.warn(`[codeindex] could not remove legacy Vectra index ${dir}: ${errorMessage(e)}`)
    }
  }
  if (removed) console.log(`[codeindex] removed ${removed} legacy Vectra index dir(s)`)
}

async function fullScan(s: SessionState): Promise<void> {
  if (!isLive(s)) return
  const startedAt = Date.now()
  s.lastProgressEmitAt = 0
  try {
    const result = await runFullScan({
      ...indexContext(s),
      saveManifest: () => saveManifest(s.manifestPath, s.manifest),
      onProgress: (p) => {
        const now = Date.now()
        const isTick = p.phase === 'embedding' && p.filesDone !== 0 && p.filesDone !== p.filesTotal
        if (isTick && now - s.lastProgressEmitAt < PROGRESS_EMIT_INTERVAL_MS) return
        s.lastProgressEmitAt = now
        emitStatus(s, { phase: p.phase, filesTotal: p.filesTotal, filesDone: p.filesDone, message: p.message })
      }
    })
    if (result.aborted || !isLive(s)) return
    console.log(
      `[codeindex] full scan: ${result.filesTotal} file(s), ${s.budget.total} chunk(s), ` +
        `${result.prunedOrphans} orphan path(s) pruned, ${result.cappedFiles} capped, ${Date.now() - startedAt}ms`
    )
    emitStatus(s, { phase: 'idle', lastUpdatedAt: Date.now(), message: capMessage(result.cappedFiles) })
  } catch (e) {
    if (!isLive(s)) return
    console.error('[codeindex] full scan failed', e)
    emitStatus(s, { phase: 'error', message: errorMessage(e) })
  }
}

function scheduleDrain(s: SessionState): void {
  if (s.drainQueued || !isLive(s)) return
  s.drainQueued = true
  void s.queue.run(() => drainPending(s))
}

function scheduleRescan(s: SessionState): void {
  if (s.rescanQueued || !isLive(s)) return
  s.rescanQueued = true
  const timer = setTimeout(() => {
    void s.queue.run(async () => {
      s.rescanQueued = false
      invalidateGitignoreCache(s.root)
      await fullScan(s)
    })
  }, RESCAN_DELAY_MS)
  timer.unref?.()
}

function deferPath(s: SessionState, relPath: string, delayMs: number): void {
  if (s.deferTimers.has(relPath)) return
  const timer = setTimeout(() => {
    s.deferTimers.delete(relPath)
    if (!isLive(s)) return
    s.pendingPaths.add(relPath)
    scheduleDrain(s)
  }, delayMs)
  timer.unref?.()
  s.deferTimers.set(relPath, timer)
}

function pauseLiveUpdates(s: SessionState, lastError: unknown): void {
  s.liveUpdatesPaused = true
  s.watcher.stop()
  for (const t of s.deferTimers.values()) clearTimeout(t)
  s.deferTimers.clear()
  s.pendingPaths.clear()
  console.error(`[codeindex] live updates paused after ${s.consecutiveFailures} consecutive failures`)
  emitStatus(s, {
    phase: 'error',
    message:
      `Live index updates paused after ${s.consecutiveFailures} consecutive failures: ${errorMessage(lastError)}. ` +
      'Reopen the project or rebuild the index to retry.'
  })
}

/** Processes every path the watcher has reported so far. Runs on the session queue. */
async function drainPending(s: SessionState): Promise<void> {
  s.drainQueued = false
  if (!isLive(s) || s.liveUpdatesPaused) return
  const paths = [...s.pendingPaths]
  s.pendingPaths.clear()
  if (paths.length === 0) return

  const ctx = indexContext(s)
  const startedAt = Date.now()
  let changed = 0
  let capped = 0
  for (const relPath of paths) {
    if (!isLive(s)) return
    const last = s.lastEmbeddedAt.get(relPath)
    const now = Date.now()
    if (last !== undefined && now - last < HOT_FILE_MIN_INTERVAL_MS) {
      deferPath(s, relPath, last + HOT_FILE_MIN_INTERVAL_MS - now)
      continue
    }
    try {
      if (await isFileIndexable(s.root, relPath)) {
        const outcome = await indexFile(ctx, relPath)
        if (outcome === 'aborted') return
        if (outcome === 'indexed') {
          s.lastEmbeddedAt.set(relPath, Date.now())
          changed++
        } else if (outcome === 'removed') {
          changed++
        } else if (outcome === 'capped') {
          capped++
        }
      } else if (await removeFile(ctx, relPath)) {
        s.lastEmbeddedAt.delete(relPath)
        changed++
      }
      s.consecutiveFailures = 0
    } catch (e) {
      if (!isLive(s)) return
      s.consecutiveFailures++
      console.error('[codeindex] failed to update', relPath, e)
      if (s.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        pauseLiveUpdates(s, e)
        break
      }
    }
  }

  if (changed > 0) {
    try {
      await saveManifest(s.manifestPath, s.manifest)
    } catch (e) {
      console.error('[codeindex] failed to save manifest', e)
    }
  }
  const ms = Date.now() - startedAt
  if (ms >= 1000) console.log(`[codeindex] live update: ${paths.length} path(s), ${changed} changed, ${ms}ms`)
  if (isLive(s) && !s.liveUpdatesPaused && (changed > 0 || capped > 0)) {
    emitStatus(s, { lastUpdatedAt: Date.now(), ...(capped > 0 ? { message: capMessage(capped) } : {}) })
  }
}

/**
 * Starts (or restarts) indexing for a workspace: resolves the configured backend, detects an
 * embeddings-model change (which invalidates all existing vectors — different model = different
 * vector space, so we force a full rebuild rather than silently mixing incompatible vectors),
 * starts the live file watcher, then runs an initial full scan. Watcher events that arrive during
 * the scan wait behind it on the session's serial queue.
 */
export async function startIndexing(root: string, settings: AppSettings, models: ModelInfo[]): Promise<void> {
  await stopIndexing()

  if (!settings.codebaseIndexEnabled || !settings.embeddingsModel) return
  const apiKey = await getApiKey()
  if (!apiKey) return

  try {
    await removeLegacyVectraIndex(root)
  } catch (e) {
    console.warn(`[codeindex] could not remove legacy Vectra index: ${errorMessage(e)}`)
  }

  const vectorStore = await buildVectorStore(root, settings)
  const embeddingsModel = settings.embeddingsModel
  const modelInfo = findModelInfo(models, embeddingsModel)
  const onEmbeddingsUsage = (promptTokens: number): void => {
    if (modelInfo) trackDailySpend(promptTokens * modelInfo.promptPrice)
  }
  const mPath = manifestPath(root)

  // The watcher's callbacks need the session object, which needs the watcher; bind lazily.
  let self: SessionState | null = null
  const watcher = new CodeIndexWatcher(root, {
    onBatch: (paths) => {
      if (!self || !isLive(self) || self.liveUpdatesPaused) return
      for (const p of paths) self.pendingPaths.add(p)
      scheduleDrain(self)
    },
    onGitignoreChanged: () => {
      if (!self) return
      invalidateGitignoreCache(root)
      scheduleRescan(self)
    },
    onOverflow: () => {
      if (self) scheduleRescan(self)
    }
  })

  const s: SessionState = {
    root,
    vectorStore,
    watcher,
    abortController: new AbortController(),
    status: {
      enabled: true,
      phase: 'idle',
      filesTotal: 0,
      filesDone: 0,
      lastUpdatedAt: null,
      backend: settings.vectorStoreBackend,
      embeddingsModel
    },
    manifest: { embeddingsModel: null, files: {} },
    manifestPath: mPath,
    queue: new SerialQueue(),
    apiKey,
    embeddingsModel,
    onEmbeddingsUsage,
    budget: { total: 0, max: MAX_INDEXED_CHUNKS, skippedFiles: 0 },
    pendingPaths: new Set(),
    drainQueued: false,
    rescanQueued: false,
    lastEmbeddedAt: new Map(),
    deferTimers: new Map(),
    consecutiveFailures: 0,
    liveUpdatesPaused: false,
    lastProgressEmitAt: 0
  }
  self = s
  session = s

  try {
    await vectorStore.init()
  } catch (e) {
    console.error('[codeindex] failed to open the vector store', e)
    emitStatus(s, { phase: 'error', message: errorMessage(e) })
    return
  }

  const manifest = await loadManifest(mPath)
  if (embeddingsModelMismatch(manifest, embeddingsModel)) {
    emitStatus(s, { phase: 'scanning', message: 'Embeddings model changed — rebuilding index' })
    try {
      await vectorStore.clear()
    } catch (e) {
      emitStatus(s, { phase: 'error', message: errorMessage(e) })
      return
    }
    manifest.files = {}
  }
  manifest.embeddingsModel = embeddingsModel
  s.manifest = manifest

  if (!isLive(s)) return
  invalidateGitignoreCache(root)
  watcher.start()
  await s.queue.run(() => fullScan(s))
}

export async function stopIndexing(): Promise<void> {
  const s = session
  if (!s) return
  session = null
  s.abortController.abort()
  s.watcher.stop()
  for (const t of s.deferTimers.values()) clearTimeout(t)
  s.deferTimers.clear()
  // Let the in-flight task (if any) observe the abort before the store is closed under it.
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    s.queue.run(async () => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, STOP_TIMEOUT_MS)
    })
  ])
  if (timer) clearTimeout(timer)
  await s.vectorStore.close().catch((e) => console.warn(`[codeindex] failed to close store: ${errorMessage(e)}`))
}

export function getIndexStatus(): IndexStatus {
  if (session) return session.status
  return {
    enabled: false,
    phase: 'idle',
    filesTotal: 0,
    filesDone: 0,
    lastUpdatedAt: null,
    backend: 'local',
    embeddingsModel: null
  }
}

export async function rebuildIndex(root: string, settings: AppSettings, models: ModelInfo[]): Promise<void> {
  // Stop first: the running session's store must be closed before a second connection clears it.
  await stopIndexing()
  const vectorStore = await buildVectorStore(root, settings)
  try {
    await vectorStore.init()
    await vectorStore.clear()
  } finally {
    await vectorStore.close().catch(() => {})
  }
  await removeManifestFile(manifestPath(root))
  await startIndexing(root, settings, models)
}

async function removeManifestFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    // fine if it doesn't exist
  }
}

export async function deleteLocalIndex(root: string): Promise<void> {
  // stopIndexing closes the SQLite connection; on Windows the file can't be deleted while open.
  await stopIndexing()
  try {
    await rm(indexDir(root), { recursive: true, force: true })
  } catch {
    // ignore
  }
}

export interface SearchResult {
  path: string
  startLine: number
  endLine: number
  snippet: string
  score: number
}

/**
 * Embeds the query and returns the top-K most similar code chunks, with snippet text read
 * back from disk (we don't store full chunk text in the vector store itself — only path +
 * line range + hash — so results always reflect current file content, not a stale copy).
 * `models` is the caller's cached OpenRouter model catalog, used to price the query embedding
 * for spend tracking — passing an empty/stale list just means this one query's cost is
 * under-tracked (never over), it never blocks the search itself.
 */
export async function searchCode(query: string, topK: number, models: ModelInfo[]): Promise<SearchResult[]> {
  const s = session
  if (!s) throw new Error('Codebase index is not enabled or not yet initialized for this workspace.')
  const apiKey = await getApiKey()
  if (!apiKey) throw new Error('No OpenRouter API key configured.')
  if (!s.status.embeddingsModel) throw new Error('No embeddings model configured.')

  const result = await createEmbeddings(apiKey, s.status.embeddingsModel, [query])
  const modelInfo = findModelInfo(models, s.status.embeddingsModel)
  if (modelInfo) trackDailySpend(result.promptTokens * modelInfo.promptPrice)
  const [vector] = result.embeddings
  const matches = await s.vectorStore.query(vector, topK)

  const out: SearchResult[] = []
  for (const m of matches) {
    try {
      const abs = join(s.root, m.metadata.path)
      const content = await readFile(abs, 'utf8')
      const lines = content.split('\n')
      const snippet = lines.slice(m.metadata.startLine - 1, m.metadata.endLine).join('\n')
      out.push({ path: m.metadata.path, startLine: m.metadata.startLine, endLine: m.metadata.endLine, snippet, score: m.score })
    } catch {
      // file was deleted since it was indexed — skip, the watcher will clean it up shortly
    }
  }
  return out
}

/** True if the feature is fully configured and ready to accept `searchCode` calls right now. */
export function isIndexActive(): boolean {
  return session !== null
}
