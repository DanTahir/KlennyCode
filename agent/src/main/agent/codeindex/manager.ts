import { join } from 'node:path'
import { readFile, unlink, rm } from 'node:fs/promises'
import type { AppSettings, IndexStatus, ModelInfo } from '@shared/types'
import { createEmbeddings } from '../../openrouter/client'
import { getApiKey, getPineconeKey } from '../../settings'
import { projectDataDir } from '../../dataDir'
import { trackDailySpend } from '../spend'
import { invalidateGitignoreCache } from './filewalker'
import { runFullScan, indexSingleFile, removeSingleFile } from './indexer'
import { loadManifest, embeddingsModelMismatch } from './manifest'
import { LocalVectorStore, PineconeVectorStore, type VectorStore } from './vectorstore'
import { CodeIndexWatcher } from './watcher'

const INDEX_DIR_NAME = 'index'
const MANIFEST_FILE_NAME = 'manifest.json'

/** The codebase semantic-search index lives under `<userData>/projects/<id>/index`, not inside the project tree. */
function indexDir(root: string): string {
  return join(projectDataDir(root), INDEX_DIR_NAME)
}

interface SessionState {
  root: string
  vectorStore: VectorStore
  watcher: CodeIndexWatcher
  abortController: AbortController
  status: IndexStatus
}

let session: SessionState | null = null
let onStatusChange: ((status: IndexStatus) => void) | null = null

export function setOnStatusChange(cb: (status: IndexStatus) => void): void {
  onStatusChange = cb
}

function manifestPath(root: string): string {
  return join(indexDir(root), MANIFEST_FILE_NAME)
}

function localIndexDir(root: string): string {
  return join(indexDir(root), 'local')
}

function emitStatus(patch: Partial<IndexStatus>): void {
  if (!session) return
  session.status = { ...session.status, ...patch }
  onStatusChange?.(session.status)
}

async function buildVectorStore(root: string, settings: AppSettings): Promise<VectorStore> {
  if (settings.vectorStoreBackend === 'pinecone') {
    const key = await getPineconeKey()
    if (!key) throw new Error('Pinecone selected as vector store backend but no Pinecone API key is set.')
    if (!settings.pineconeIndexName) throw new Error('Pinecone selected as vector store backend but no index name is set.')
    return new PineconeVectorStore(key, settings.pineconeIndexName)
  }
  return new LocalVectorStore(localIndexDir(root))
}

/** Finds the priced ModelInfo for the configured embeddings model, used for spend tracking. */
function findModelInfo(models: ModelInfo[], modelId: string): ModelInfo | undefined {
  return models.find((m) => m.id === modelId)
}

/**
 * Starts (or restarts) indexing for a workspace: resolves the configured backend, detects an
 * embeddings-model change (which invalidates all existing vectors — different model = different
 * vector space, so we force a full rebuild rather than silently mixing incompatible vectors),
 * runs an initial full scan, then starts the live file watcher to keep the index fresh.
 */
export async function startIndexing(root: string, settings: AppSettings, models: ModelInfo[]): Promise<void> {
  await stopIndexing()

  if (!settings.codebaseIndexEnabled || !settings.embeddingsModel) return
  const apiKey = await getApiKey()
  if (!apiKey) return

  const abortController = new AbortController()
  const vectorStore = await buildVectorStore(root, settings)
  const embeddingsModel = settings.embeddingsModel
  const modelInfo = findModelInfo(models, embeddingsModel)
  const onEmbeddingsUsage = (promptTokens: number): void => {
    if (modelInfo) trackDailySpend(promptTokens * modelInfo.promptPrice)
  }
  const watcher = new CodeIndexWatcher(root, (relPath, kind) => {
    void handleWatcherEvent(relPath, kind, apiKey, embeddingsModel, onEmbeddingsUsage)
  })

  session = {
    root,
    vectorStore,
    watcher,
    abortController,
    status: {
      enabled: true,
      phase: 'idle',
      filesTotal: 0,
      filesDone: 0,
      lastUpdatedAt: null,
      backend: settings.vectorStoreBackend,
      embeddingsModel
    }
  }

  try {
    await vectorStore.init()
  } catch (e) {
    emitStatus({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    return
  }

  const mPath = manifestPath(root)
  const manifest = await loadManifest(mPath)
  if (embeddingsModelMismatch(manifest, embeddingsModel)) {
    emitStatus({ phase: 'scanning', message: 'Embeddings model changed — rebuilding index' })
    await vectorStore.clear()
    manifest.embeddingsModel = null
    manifest.files = {}
  }

  invalidateGitignoreCache(root)

  try {
    await runFullScan({
      root,
      manifestPath: mPath,
      vectorStore,
      apiKey,
      embeddingsModel,
      signal: abortController.signal,
      onEmbeddingsUsage,
      onProgress: (p) => emitStatus({ phase: p.phase, filesTotal: p.filesTotal, filesDone: p.filesDone, message: p.message })
    })
    emitStatus({ phase: 'idle', lastUpdatedAt: Date.now(), message: undefined })
  } catch (e) {
    if (!abortController.signal.aborted) {
      emitStatus({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    }
    return
  }

  if (!abortController.signal.aborted) watcher.start()
}

async function handleWatcherEvent(
  relPath: string,
  kind: 'change' | 'delete',
  apiKey: string,
  embeddingsModel: string,
  onEmbeddingsUsage: (promptTokens: number) => void
): Promise<void> {
  if (!session) return
  const { root, vectorStore } = session
  const mPath = manifestPath(root)
  try {
    if (kind === 'delete') {
      await removeSingleFile(mPath, relPath, vectorStore)
    } else {
      await indexSingleFile(root, mPath, relPath, vectorStore, apiKey, embeddingsModel, onEmbeddingsUsage)
    }
    emitStatus({ lastUpdatedAt: Date.now() })
  } catch (e) {
    console.error('codeindex watcher: failed to re-index', relPath, e)
  }
}

export async function stopIndexing(): Promise<void> {
  if (!session) return
  session.abortController.abort()
  session.watcher.stop()
  session = null
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
  if (session) {
    await session.vectorStore.clear()
  } else {
    // No active session (feature currently disabled) — clear whichever backend is configured
    // so a stale on-disk local index isn't left around, then let startIndexing rebuild fresh.
    const vectorStore = await buildVectorStore(root, settings)
    await vectorStore.init()
    await vectorStore.clear()
  }
  const mPath = manifestPath(root)
  await removeManifestFile(mPath)
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
  if (!session) throw new Error('Codebase index is not enabled or not yet initialized for this workspace.')
  const apiKey = await getApiKey()
  if (!apiKey) throw new Error('No OpenRouter API key configured.')
  if (!session.status.embeddingsModel) throw new Error('No embeddings model configured.')

  const result = await createEmbeddings(apiKey, session.status.embeddingsModel, [query])
  const modelInfo = findModelInfo(models, session.status.embeddingsModel)
  if (modelInfo) trackDailySpend(result.promptTokens * modelInfo.promptPrice)
  const [vector] = result.embeddings
  const matches = await session.vectorStore.query(vector, topK)

  const out: SearchResult[] = []
  for (const m of matches) {
    try {
      const abs = join(session.root, m.metadata.path)
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
