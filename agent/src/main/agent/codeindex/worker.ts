import { parentPort, workerData } from 'node:worker_threads'
import { SqliteVectorStore } from './sqliteStore'
import type { WorkerReply, WorkerRequest } from './workerProtocol'

/**
 * Worker-thread entry for the local code index (built as its own `codeindexWorker` entry, see
 * electron.vite.config.ts). It owns the SQLite connection, so every query, upsert and delete runs
 * off Electron's main process. Messages are handled one at a time in arrival order: each handler
 * does only synchronous SQLite work between awaits of already-resolved promises.
 */
const port = parentPort
if (!port) throw new Error('codeindex worker must be started as a worker thread')

const store = new SqliteVectorStore((workerData as { dbPath: string }).dbPath)

async function dispatch(req: WorkerRequest): Promise<unknown> {
  if (req.method === 'close') {
    await store.close()
    return null
  }
  // Lazy and idempotent: a worker restarted after a crash re-opens the database on its first call.
  await store.init()
  switch (req.method) {
    case 'init':
      return null
    case 'upsertBatch':
      return store.upsertBatch(req.items)
    case 'deleteByIds':
      return store.deleteByIds(req.ids)
    case 'deleteByPath':
      return store.deleteByPath(req.path)
    case 'query':
      return store.query(req.vector, req.topK)
    case 'clear':
      return store.clear()
    case 'count':
      return store.count()
    case 'listPaths':
      return store.listPaths()
  }
}

port.on('message', (req: WorkerRequest) => {
  dispatch(req).then(
    (result) => port.postMessage({ seq: req.seq, ok: true, result: result ?? null } satisfies WorkerReply),
    (e: unknown) =>
      port.postMessage({
        seq: req.seq,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        errorName: e instanceof Error ? e.name : 'Error'
      } satisfies WorkerReply)
  )
})
