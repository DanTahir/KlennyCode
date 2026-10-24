import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SqliteVectorStore } from '../src/main/agent/codeindex/sqliteStore'
import { WorkerVectorStore } from '../src/main/agent/codeindex/workerStore'
import { openVecDatabase, toUnpackedPath } from '../src/main/agent/codeindex/sqliteDriver'
import type { VectorStore } from '../src/main/agent/codeindex/vectorstore'

const tempDirs: string[] = []
const openStores: VectorStore[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klenny-codeindex-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (openStores.length) await openStores.pop()?.close().catch(() => {})
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

// bun:sqlite can only load extensions where the linked SQLite allows it (not Apple's system
// SQLite on macOS), so these suites skip rather than fail when sqlite-vec can't be loaded.
function vecAvailable(): boolean {
  try {
    openVecDatabase(':memory:').close()
    return true
  } catch {
    return false
  }
}
const canRun = vecAvailable()

const WORKER_SCRIPT = fileURLToPath(new URL('../src/main/agent/codeindex/worker.ts', import.meta.url))

// Small deterministic 3-dim vectors — real embeddings are much higher-dimensional, but the
// vector store logic (upsert/query/delete) doesn't care about dimensionality, only that
// cosine similarity ranks "closer" vectors higher.
const V_A = [1, 0, 0]
const V_B = [0, 1, 0]
const V_A_CLOSE = [0.9, 0.1, 0]

type Factory = (dir: string) => VectorStore

const factories: Array<[string, Factory]> = [
  ['SqliteVectorStore', (dir) => new SqliteVectorStore(join(dir, 'vectors.sqlite'))],
  ['WorkerVectorStore', (dir) => new WorkerVectorStore(WORKER_SCRIPT, join(dir, 'vectors.sqlite'))]
]

for (const [name, factory] of factories) {
  describe.skipIf(!canRun)(name, () => {
    async function freshStore(): Promise<VectorStore> {
      const store = factory(await makeTempDir())
      openStores.push(store)
      await store.init()
      return store
    }

    test('init creates an empty index', async () => {
      const store = await freshStore()
      expect(await store.count()).toBe(0)
      expect(await store.query(V_A, 5)).toEqual([])
    })

    test('upsertBatch stores items retrievable by query, ranked by cosine similarity', async () => {
      const store = await freshStore()
      await store.upsertBatch([
        { id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 5, hash: 'h1' } },
        { id: 'b', vector: V_B, metadata: { path: 'b.ts', startLine: 1, endLine: 5, hash: 'h2' } }
      ])
      expect(await store.count()).toBe(2)

      const results = await store.query(V_A_CLOSE, 2)
      expect(results.length).toBe(2)
      expect(results[0].id).toBe('a')
      expect(results[0].metadata).toEqual({ path: 'a.ts', startLine: 1, endLine: 5, hash: 'h1' })
      expect(results[0].score).toBeGreaterThan(results[1].score)
      expect(results[0].score).toBeGreaterThan(0.9)
    })

    test('accepts Float32Array vectors', async () => {
      const store = await freshStore()
      await store.upsertBatch([{ id: 'a', vector: new Float32Array(V_A), metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h' } }])
      const [hit] = await store.query(new Float32Array(V_A), 1)
      expect(hit.id).toBe('a')
      expect(hit.score).toBeCloseTo(1, 5)
    })

    test('deleteByIds removes only the specified items', async () => {
      const store = await freshStore()
      await store.upsertBatch([
        { id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h1' } },
        { id: 'b', vector: V_B, metadata: { path: 'b.ts', startLine: 1, endLine: 1, hash: 'h2' } }
      ])
      await store.deleteByIds(['a', 'does-not-exist'])
      expect(await store.count()).toBe(1)
      const results = await store.query(V_A, 5)
      expect(results.map((r) => r.id)).toEqual(['b'])
    })

    test('deleteByPath removes every chunk for that file, leaving others intact', async () => {
      const store = await freshStore()
      await store.upsertBatch([
        { id: 'a1', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 10, hash: 'h1' } },
        { id: 'a2', vector: V_A_CLOSE, metadata: { path: 'a.ts', startLine: 11, endLine: 20, hash: 'h2' } },
        { id: 'b1', vector: V_B, metadata: { path: 'b.ts', startLine: 1, endLine: 10, hash: 'h3' } }
      ])
      await store.deleteByPath('a.ts')
      expect(await store.count()).toBe(1)
      const results = await store.query(V_B, 5)
      expect(results.map((r) => r.id)).toEqual(['b1'])
      expect(await store.listPaths()).toEqual(['b.ts'])
    })

    test('clear wipes all stored vectors but leaves the index usable, even at a new dimension', async () => {
      const store = await freshStore()
      await store.upsertBatch([{ id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h1' } }])
      await store.clear()
      expect(await store.count()).toBe(0)
      // still usable after clear — and the dimension is re-learned from the next upsert
      await store.upsertBatch([{ id: 'b', vector: [0, 1, 0, 0], metadata: { path: 'b.ts', startLine: 1, endLine: 1, hash: 'h2' } }])
      expect(await store.count()).toBe(1)
      expect((await store.query([0, 1, 0, 0], 1))[0].id).toBe('b')
    })

    test('upsertBatch is a no-op for an empty array', async () => {
      const store = await freshStore()
      await store.upsertBatch([])
      expect(await store.count()).toBe(0)
    })

    test('re-upserting the same id replaces rather than duplicates', async () => {
      const store = await freshStore()
      await store.upsertBatch([{ id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h1' } }])
      await store.upsertBatch([{ id: 'a', vector: V_B, metadata: { path: 'a.ts', startLine: 2, endLine: 3, hash: 'h2' } }])
      expect(await store.count()).toBe(1)
      const results = await store.query(V_B, 5)
      expect(results.length).toBe(1)
      expect(results[0].metadata).toEqual({ path: 'a.ts', startLine: 2, endLine: 3, hash: 'h2' })
      expect(results[0].score).toBeCloseTo(1, 5)
    })

    test('rejects a vector whose dimension differs from the stored index', async () => {
      const store = await freshStore()
      await store.upsertBatch([{ id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h1' } }])
      // Rejections are captured with .then(ok, err) rather than expect(...).rejects: under Bun
      // 1.3, `rejects` never observes a rejection that arrives via a worker_threads message
      // (the test hangs), while a plain await does.
      const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as Error)
      const upsertErr = await settle(
        store.upsertBatch([{ id: 'b', vector: [1, 0], metadata: { path: 'b.ts', startLine: 1, endLine: 1, hash: 'h2' } }])
      )
      expect(upsertErr?.message).toMatch(/dimension mismatch/i)
      const queryErr = await settle(store.query([1, 0], 1))
      expect(queryErr?.message).toMatch(/dimension mismatch/i)
    })

    test('data persists across close and reopen', async () => {
      const dir = await makeTempDir()
      const first = factory(dir)
      await first.init()
      await first.upsertBatch([{ id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h1' } }])
      await first.close()
      const second = factory(dir)
      openStores.push(second)
      await second.init()
      expect(await second.count()).toBe(1)
      expect((await second.query(V_A, 1))[0].id).toBe('a')
    })
  })
}

describe('toUnpackedPath', () => {
  test('redirects a path inside app.asar to app.asar.unpacked', () => {
    expect(toUnpackedPath('C:\\App\\resources\\app.asar\\node_modules\\sqlite-vec-windows-x64\\vec0.dll')).toBe(
      'C:\\App\\resources\\app.asar.unpacked\\node_modules\\sqlite-vec-windows-x64\\vec0.dll'
    )
    expect(toUnpackedPath('/opt/App/resources/app.asar/node_modules/x/vec0.so')).toBe(
      '/opt/App/resources/app.asar.unpacked/node_modules/x/vec0.so'
    )
  })

  test('leaves already-unpacked and non-asar paths alone', () => {
    expect(toUnpackedPath('/r/app.asar.unpacked/node_modules/x/vec0.so')).toBe('/r/app.asar.unpacked/node_modules/x/vec0.so')
    expect(toUnpackedPath('/home/me/dev/node_modules/x/vec0.so')).toBe('/home/me/dev/node_modules/x/vec0.so')
  })
})
