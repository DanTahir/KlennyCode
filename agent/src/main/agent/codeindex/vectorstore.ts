export interface ChunkMetadata {
  path: string
  startLine: number
  endLine: number
  hash: string
}

export interface QueryMatch {
  id: string
  score: number
  metadata: ChunkMetadata
}

/** Embedding vectors may be plain arrays (as returned by the embeddings API) or Float32Array. */
export type VectorInput = number[] | Float32Array

/**
 * Storage/query backend for embedded code chunks. Implementations: `SqliteVectorStore`
 * (sqlite-vec, local file, run inside a worker thread via `WorkerVectorStore`) and
 * `PineconeVectorStore` (cloud, opt-in). All sit behind this interface so the
 * indexer/manager/tool code never branches on backend.
 */
export interface VectorStore {
  init(): Promise<void>
  /** Batch upsert — implementations should apply this as a single transaction where possible. */
  upsertBatch(items: Array<{ id: string; vector: VectorInput; metadata: ChunkMetadata }>): Promise<void>
  deleteByIds(ids: string[]): Promise<void>
  deleteByPath(path: string): Promise<void>
  query(vector: VectorInput, topK: number): Promise<QueryMatch[]>
  /** Wipes all stored vectors — used when the embeddings model changes (different vector space) or the user hits "Delete index". */
  clear(): Promise<void>
  /** Total number of stored chunks, used for status reporting. -1 means unknown. */
  count(): Promise<number>
  /**
   * Distinct file paths that currently have stored chunks, or null if the backend cannot list
   * them (Pinecone). Used to reconcile the manifest with the store, pruning orphaned vectors and
   * re-embedding files the manifest lists but the store lacks.
   */
  listPaths(): Promise<string[] | null>
  /** Releases resources (database handle, worker thread). The store is unusable afterwards. */
  close(): Promise<void>
}

const PINECONE_CONTROL_PLANE = 'https://api.pinecone.io'
const PINECONE_API_VERSION = '2024-10'

function toNumberArray(vector: VectorInput): number[] {
  return Array.isArray(vector) ? vector : Array.from(vector)
}

/**
 * Thin REST wrapper around Pinecone's vector API. Pinecone has no built-in "skip unchanged
 * chunk" support, so callers relying on hash-based dedup should track hashes themselves (see
 * indexer.ts's manifest) — this class just does upsert/query/delete.
 *
 * Users only provide an API key + index name in Settings (matching the approved plan) — the
 * data-plane host required for actual vector operations is resolved once via Pinecone's
 * control-plane "describe index" endpoint and cached for the lifetime of this instance.
 */
export class PineconeVectorStore implements VectorStore {
  private indexHost: string | null = null

  constructor(
    private apiKey: string,
    private indexName: string
  ) {}

  async init(): Promise<void> {
    const res = await fetch(`${PINECONE_CONTROL_PLANE}/indexes/${encodeURIComponent(this.indexName)}`, {
      headers: { 'Api-Key': this.apiKey, 'X-Pinecone-Api-Version': PINECONE_API_VERSION }
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Could not find Pinecone index "${this.indexName}": ${res.status}${text ? ` — ${text}` : ''}`)
    }
    const json = (await res.json()) as { host?: string }
    if (!json.host) throw new Error(`Pinecone index "${this.indexName}" has no host in its description.`)
    this.indexHost = json.host
  }

  private async request(path: string, body: unknown): Promise<Record<string, unknown>> {
    if (!this.indexHost) throw new Error('PineconeVectorStore.init() must be called before use.')
    const res = await fetch(`https://${this.indexHost}${path}`, {
      method: 'POST',
      headers: {
        'Api-Key': this.apiKey,
        'Content-Type': 'application/json',
        'X-Pinecone-Api-Version': PINECONE_API_VERSION
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Pinecone request to ${path} failed: ${res.status}${text ? ` — ${text}` : ''}`)
    }
    return (await res.json()) as Record<string, unknown>
  }

  async upsertBatch(items: Array<{ id: string; vector: VectorInput; metadata: ChunkMetadata }>): Promise<void> {
    if (items.length === 0) return
    // Pinecone recommends batches of ~100 vectors per request.
    const BATCH = 100
    for (let i = 0; i < items.length; i += BATCH) {
      const slice = items.slice(i, i + BATCH)
      await this.request('/vectors/upsert', {
        vectors: slice.map((it) => ({ id: it.id, values: toNumberArray(it.vector), metadata: it.metadata }))
      })
    }
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.request('/vectors/delete', { ids })
  }

  async deleteByPath(path: string): Promise<void> {
    await this.request('/vectors/delete', { filter: { path: { $eq: path } } })
  }

  async query(vector: VectorInput, topK: number): Promise<QueryMatch[]> {
    const json = await this.request('/query', { vector: toNumberArray(vector), topK, includeMetadata: true })
    const matches = (json.matches as Array<{ id: string; score: number; metadata: ChunkMetadata }>) ?? []
    return matches.map((m) => ({ id: m.id, score: m.score, metadata: m.metadata }))
  }

  async clear(): Promise<void> {
    await this.request('/vectors/delete', { deleteAll: true })
  }

  async count(): Promise<number> {
    // Pinecone's describeIndexStats is a separate (non /query) endpoint; approximate by
    // returning -1 (unknown) rather than adding another request path just for a status number.
    // Callers should treat -1 as "unknown, ask Pinecone's console".
    return -1
  }

  async listPaths(): Promise<string[] | null> {
    return null
  }

  async close(): Promise<void> {
    // Stateless HTTP client — nothing to release.
  }
}
