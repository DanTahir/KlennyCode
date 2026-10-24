import { Worker } from 'node:worker_threads'
import type { ChunkMetadata, QueryMatch, VectorInput, VectorStore } from './vectorstore'
import type { WorkerReply, WorkerRequest } from './workerProtocol'

/** Calls slower than this are logged, since they show up as index latency. */
const SLOW_CALL_LOG_MS = 500
/** How long close() waits for the worker to close the database before terminating it. */
const CLOSE_TIMEOUT_MS = 3000

type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'seq'> : never) : never

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  method: string
  startedAt: number
}

function toFloat32(vector: VectorInput): Float32Array {
  // Always a fresh copy: its buffer is transferred to the worker, which would otherwise detach a
  // Float32Array the caller still owns.
  return Float32Array.from(vector)
}

/**
 * VectorStore proxy that runs SqliteVectorStore in a worker thread (worker.ts), so index I/O and
 * brute-force KNN over thousands of high-dimensional vectors never run on Electron's main process.
 * The worker starts lazily and is restarted on the next call if it dies, because the worker
 * re-opens the database on demand. Vectors cross the thread boundary as transferred Float32Array
 * buffers instead of structured-cloned number arrays.
 */
export class WorkerVectorStore implements VectorStore {
  private worker: Worker | null = null
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private closed = false

  constructor(
    private readonly scriptPath: string,
    private readonly dbPath: string
  ) {}

  private getWorker(): Worker {
    if (this.closed) throw new Error('The code index store has been closed.')
    if (this.worker) return this.worker
    const worker = new Worker(this.scriptPath, { workerData: { dbPath: this.dbPath } })
    // An idle worker must never keep the process alive (app quit, test runner exit), but while a
    // reply is outstanding it is ref'd so the process can't exit with a request in flight.
    // See updateRef().
    worker.unref()
    worker.on('message', (reply: WorkerReply) => this.onReply(reply))
    worker.on('error', (err) => {
      console.error('[codeindex] worker error:', err)
      this.failAll(err instanceof Error ? err : new Error(String(err)))
    })
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null
      this.failAll(new Error(`Code index worker exited (code ${code}).`))
    })
    this.worker = worker
    return worker
  }

  /** Ref the worker exactly while requests are in flight. */
  private updateRef(): void {
    if (!this.worker) return
    if (this.pending.size > 0) this.worker.ref()
    else this.worker.unref()
  }

  private onReply(reply: WorkerReply): void {
    const p = this.pending.get(reply.seq)
    if (!p) return
    this.pending.delete(reply.seq)
    this.updateRef()
    const ms = Date.now() - p.startedAt
    if (ms >= SLOW_CALL_LOG_MS) console.log(`[codeindex] store.${p.method} took ${ms}ms`)
    if (reply.ok) {
      p.resolve(reply.result)
    } else {
      const err = new Error(reply.error)
      err.name = reply.errorName
      p.reject(err)
    }
  }

  private failAll(error: Error): void {
    const entries = [...this.pending.values()]
    this.pending.clear()
    this.updateRef()
    for (const p of entries) p.reject(error)
  }

  private call<T>(body: RequestBody, transfer: ArrayBuffer[] = []): Promise<T> {
    let worker: Worker
    try {
      worker = this.getWorker()
    } catch (e) {
      return Promise.reject(e)
    }
    const seq = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(seq, { resolve: resolve as (v: unknown) => void, reject, method: body.method, startedAt: Date.now() })
      this.updateRef()
      worker.postMessage({ ...body, seq } as WorkerRequest, transfer)
    })
  }

  async init(): Promise<void> {
    await this.call({ method: 'init' })
  }

  async upsertBatch(items: Array<{ id: string; vector: VectorInput; metadata: ChunkMetadata }>): Promise<void> {
    if (items.length === 0) return
    const wire = items.map((it) => ({ id: it.id, vector: toFloat32(it.vector), metadata: it.metadata }))
    await this.call({ method: 'upsertBatch', items: wire }, wire.map((it) => it.vector.buffer as ArrayBuffer))
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.call({ method: 'deleteByIds', ids })
  }

  async deleteByPath(path: string): Promise<void> {
    await this.call({ method: 'deleteByPath', path })
  }

  async query(vector: VectorInput, topK: number): Promise<QueryMatch[]> {
    const v = toFloat32(vector)
    return this.call<QueryMatch[]>({ method: 'query', vector: v, topK }, [v.buffer as ArrayBuffer])
  }

  async clear(): Promise<void> {
    await this.call({ method: 'clear' })
  }

  async count(): Promise<number> {
    return this.call<number>({ method: 'count' })
  }

  async listPaths(): Promise<string[]> {
    return this.call<string[]>({ method: 'listPaths' })
  }

  /** Closes the database (checkpointing the WAL) and terminates the worker. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return
    const worker = this.worker
    if (worker) {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          this.call({ method: 'close' }),
          new Promise((resolve) => {
            timer = setTimeout(resolve, CLOSE_TIMEOUT_MS)
          })
        ])
      } catch {
        // Closing is best-effort; terminate regardless.
      } finally {
        if (timer) clearTimeout(timer)
      }
      this.closed = true
      await worker.terminate().catch(() => 0)
    }
    this.closed = true
    this.worker = null
    this.failAll(new Error('The code index store has been closed.'))
  }
}
