import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openVecDatabase, type SqliteDatabase } from './sqliteDriver'
// Type-only imports: this module runs inside the index worker thread, and a value import from a
// module the main bundle also uses would make the bundler emit a shared chunk for both entries.
import type { ChunkMetadata, QueryMatch, VectorInput, VectorStore } from './vectorstore'

/** Maximum `k` accepted by sqlite-vec's KNN query. */
const MAX_KNN_K = 4096

export class EmbeddingDimensionMismatchError extends Error {
  constructor(expected: number, actual: number) {
    super(
      `Embedding dimension mismatch: the index stores ${expected}-dimensional vectors but got ${actual}. ` +
        'Rebuild the index after changing the embeddings model.'
    )
    this.name = 'EmbeddingDimensionMismatchError'
  }
}

function toBlob(vector: VectorInput): Buffer {
  const f32 = vector instanceof Float32Array ? vector : Float32Array.from(vector)
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)
}

interface ChunkRow {
  rid: number
  id: string
  path: string
  start_line: number
  end_line: number
  hash: string
  distance: number
}

/**
 * Local vector store backed by SQLite + sqlite-vec.
 *
 * It replaces Vectra, which kept the entire index (every 4096-dim vector, as JSON) in one
 * `index.json` and re-stringified ALL of it on every update. At ~88 KB per chunk a 6k-chunk index
 * was 532 MB, and each file-watcher event rewrote it on Electron's main process, freezing the UI.
 * Here, an update touches only the affected rows.
 *
 * Layout:
 *   - `chunks`: one row per chunk (string id, path, line range, hash). `rid` is the integer key
 *     shared with the vector table.
 *   - `vec_chunks`: a sqlite-vec `vec0` virtual table (cosine distance) keyed by the same rowid.
 *     It is created lazily on the first upsert, because its dimension is only known once the
 *     embeddings model has produced a vector. The dimension is recorded in `meta`.
 *
 * All calls are synchronous under the hood. In the app this class only ever runs inside the index
 * worker thread (see worker.ts / workerStore.ts), so even a large KNN scan never blocks the UI.
 */
export class SqliteVectorStore implements VectorStore {
  private db: SqliteDatabase | null = null
  private dimension: number | null = null

  constructor(private readonly dbPath: string) {}

  async init(): Promise<void> {
    if (this.db) return
    if (this.dbPath !== ':memory:') mkdirSync(dirname(this.dbPath), { recursive: true })
    const db = openVecDatabase(this.dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec(
      'CREATE TABLE IF NOT EXISTS chunks (rid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, ' +
        'start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, hash TEXT NOT NULL)'
    )
    db.exec('CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path)')
    const row = db.prepare("SELECT value FROM meta WHERE key = 'dimension'").get() as { value: string } | undefined
    this.dimension = row ? Number(row.value) : null
    this.db = db
  }

  private requireDb(): SqliteDatabase {
    if (!this.db) throw new Error('SqliteVectorStore.init() must be called before use.')
    return this.db
  }

  private ensureVectorTable(dimension: number): void {
    if (this.dimension !== null) {
      if (this.dimension !== dimension) throw new EmbeddingDimensionMismatchError(this.dimension, dimension)
      return
    }
    if (!Number.isInteger(dimension) || dimension <= 0) throw new Error(`Invalid embedding dimension: ${dimension}`)
    const db = this.requireDb()
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${dimension}] distance_metric=cosine)`)
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('dimension', ?)").run(String(dimension))
    this.dimension = dimension
  }

  async upsertBatch(items: Array<{ id: string; vector: VectorInput; metadata: ChunkMetadata }>): Promise<void> {
    if (items.length === 0) return
    const db = this.requireDb()
    const dimension = items[0].vector.length
    for (const item of items) {
      if (item.vector.length !== dimension) throw new EmbeddingDimensionMismatchError(dimension, item.vector.length)
    }
    this.ensureVectorTable(dimension)

    const selectRid = db.prepare('SELECT rid FROM chunks WHERE id = ?')
    const updateChunk = db.prepare('UPDATE chunks SET path = ?, start_line = ?, end_line = ?, hash = ? WHERE rid = ?')
    const insertChunk = db.prepare(
      'INSERT INTO chunks (id, path, start_line, end_line, hash) VALUES (?, ?, ?, ?, ?) RETURNING rid'
    )
    const deleteVector = db.prepare('DELETE FROM vec_chunks WHERE rowid = ?')
    // vec0 rejects a non-integer primary key, and better-sqlite3 binds plain JS numbers as REAL,
    // so rowids are always bound as BigInt.
    const insertVector = db.prepare('INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)')

    db.transaction(() => {
      for (const { id, vector, metadata } of items) {
        const existing = selectRid.get(id) as { rid: number } | undefined
        let rid: bigint
        if (existing) {
          rid = BigInt(existing.rid)
          updateChunk.run(metadata.path, metadata.startLine, metadata.endLine, metadata.hash, rid)
          deleteVector.run(rid)
        } else {
          const inserted = insertChunk.get(id, metadata.path, metadata.startLine, metadata.endLine, metadata.hash) as {
            rid: number
          }
          rid = BigInt(inserted.rid)
        }
        insertVector.run(rid, toBlob(vector))
      }
    })
  }

  private deleteRids(rids: number[]): void {
    if (rids.length === 0) return
    const db = this.requireDb()
    const deleteChunk = db.prepare('DELETE FROM chunks WHERE rid = ?')
    const deleteVector = this.dimension !== null ? db.prepare('DELETE FROM vec_chunks WHERE rowid = ?') : null
    db.transaction(() => {
      for (const rid of rids) {
        deleteVector?.run(BigInt(rid))
        deleteChunk.run(BigInt(rid))
      }
    })
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    const selectRid = this.requireDb().prepare('SELECT rid FROM chunks WHERE id = ?')
    const rids: number[] = []
    for (const id of ids) {
      const row = selectRid.get(id) as { rid: number } | undefined
      if (row) rids.push(row.rid)
    }
    this.deleteRids(rids)
  }

  async deleteByPath(path: string): Promise<void> {
    const rows = this.requireDb().prepare('SELECT rid FROM chunks WHERE path = ?').all(path) as Array<{ rid: number }>
    this.deleteRids(rows.map((r) => r.rid))
  }

  async query(vector: VectorInput, topK: number): Promise<QueryMatch[]> {
    const db = this.requireDb()
    if (this.dimension === null) return []
    if (vector.length !== this.dimension) throw new EmbeddingDimensionMismatchError(this.dimension, vector.length)
    // Inlined as a literal rather than bound: vec0 requires an INTEGER `k`, and how a JS number
    // is bound (REAL vs INTEGER) differs between drivers. It is clamped to a safe integer here.
    const k = Math.max(1, Math.min(MAX_KNN_K, Math.floor(topK) || 1))
    const rows = db
      .prepare(
        `WITH knn AS (SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ${k}) ` +
          'SELECT c.rid, c.id, c.path, c.start_line, c.end_line, c.hash, knn.distance FROM knn ' +
          'JOIN chunks c ON c.rid = knn.rowid ORDER BY knn.distance'
      )
      .all(toBlob(vector)) as ChunkRow[]
    return rows.map((r) => ({
      id: r.id,
      // Cosine distance is 1 - cosine similarity; report similarity, as Vectra and Pinecone did.
      score: 1 - r.distance,
      metadata: { path: r.path, startLine: r.start_line, endLine: r.end_line, hash: r.hash }
    }))
  }

  async clear(): Promise<void> {
    const db = this.requireDb()
    db.exec('DROP TABLE IF EXISTS vec_chunks')
    db.exec('DELETE FROM chunks')
    db.exec("DELETE FROM meta WHERE key = 'dimension'")
    this.dimension = null
    // A cleared index is usually about to be rebuilt with a different model; give the space back
    // instead of leaving a file the size of the old index on disk.
    db.exec('VACUUM')
  }

  async count(): Promise<number> {
    const row = this.requireDb().prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
    return Number(row.n)
  }

  async listPaths(): Promise<string[]> {
    const rows = this.requireDb().prepare('SELECT DISTINCT path FROM chunks').all() as Array<{ path: string }>
    return rows.map((r) => r.path)
  }

  async close(): Promise<void> {
    this.db?.close()
    this.db = null
  }
}
