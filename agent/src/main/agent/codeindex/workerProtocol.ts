import type { ChunkMetadata } from './vectorstore'

/** Wire protocol between WorkerVectorStore (main thread) and worker.ts. Types only. */
export type WorkerRequest = { seq: number } & (
  | { method: 'init' }
  | { method: 'upsertBatch'; items: Array<{ id: string; vector: Float32Array; metadata: ChunkMetadata }> }
  | { method: 'deleteByIds'; ids: string[] }
  | { method: 'deleteByPath'; path: string }
  | { method: 'query'; vector: Float32Array; topK: number }
  | { method: 'clear' }
  | { method: 'count' }
  | { method: 'listPaths' }
  | { method: 'close' }
)

export type WorkerMethod = WorkerRequest['method']

export type WorkerReply =
  | { seq: number; ok: true; result: unknown }
  | { seq: number; ok: false; error: string; errorName: string }
