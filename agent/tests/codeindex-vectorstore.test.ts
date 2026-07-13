import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalVectorStore } from '../src/main/agent/codeindex/vectorstore'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klenny-codeindex-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

// Small deterministic 3-dim vectors — real embeddings are much higher-dimensional, but the
// vector store logic (upsert/query/delete) doesn't care about dimensionality, only that
// cosine similarity ranks "closer" vectors higher.
const V_A = [1, 0, 0]
const V_B = [0, 1, 0]
const V_A_CLOSE = [0.9, 0.1, 0]

describe('LocalVectorStore', () => {
  test('init creates the index if it does not already exist', async () => {
    const dir = await makeTempDir()
    const store = new LocalVectorStore(dir)
    await store.init()
    expect(await store.count()).toBe(0)
  })

  test('upsertBatch stores items retrievable by query', async () => {
    const dir = await makeTempDir()
    const store = new LocalVectorStore(dir)
    await store.init()
    await store.upsertBatch([
      { id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 5, hash: 'h1' } },
      { id: 'b', vector: V_B, metadata: { path: 'b.ts', startLine: 1, endLine: 5, hash: 'h2' } }
    ])
    expect(await store.count()).toBe(2)

    const results = await store.query(V_A_CLOSE, 2)
    expect(results.length).toBe(2)
    // The vector closest to V_A_CLOSE (item "a") should rank first.
    expect(results[0].id).toBe('a')
    expect(results[0].metadata.path).toBe('a.ts')
  })

  test('deleteByIds removes only the specified items', async () => {
    const dir = await makeTempDir()
    const store = new LocalVectorStore(dir)
    await store.init()
    await store.upsertBatch([
      { id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h1' } },
      { id: 'b', vector: V_B, metadata: { path: 'b.ts', startLine: 1, endLine: 1, hash: 'h2' } }
    ])
    await store.deleteByIds(['a'])
    expect(await store.count()).toBe(1)
    const results = await store.query(V_A, 5)
    expect(results.map((r) => r.id)).toEqual(['b'])
  })

  test('deleteByPath removes every chunk for that file, leaving others intact', async () => {
    const dir = await makeTempDir()
    const store = new LocalVectorStore(dir)
    await store.init()
    await store.upsertBatch([
      { id: 'a1', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 10, hash: 'h1' } },
      { id: 'a2', vector: V_A_CLOSE, metadata: { path: 'a.ts', startLine: 11, endLine: 20, hash: 'h2' } },
      { id: 'b1', vector: V_B, metadata: { path: 'b.ts', startLine: 1, endLine: 10, hash: 'h3' } }
    ])
    await store.deleteByPath('a.ts')
    expect(await store.count()).toBe(1)
    const results = await store.query(V_B, 5)
    expect(results.map((r) => r.id)).toEqual(['b1'])
  })

  test('clear wipes all stored vectors but leaves the index usable', async () => {
    const dir = await makeTempDir()
    const store = new LocalVectorStore(dir)
    await store.init()
    await store.upsertBatch([{ id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h1' } }])
    expect(await store.count()).toBe(1)
    await store.clear()
    expect(await store.count()).toBe(0)
    // still usable after clear — a fresh upsert should work without re-calling init()
    await store.upsertBatch([{ id: 'b', vector: V_B, metadata: { path: 'b.ts', startLine: 1, endLine: 1, hash: 'h2' } }])
    expect(await store.count()).toBe(1)
  })

  test('upsertBatch is a no-op for an empty array', async () => {
    const dir = await makeTempDir()
    const store = new LocalVectorStore(dir)
    await store.init()
    await store.upsertBatch([])
    expect(await store.count()).toBe(0)
  })

  test('re-upserting the same id replaces rather than duplicates', async () => {
    const dir = await makeTempDir()
    const store = new LocalVectorStore(dir)
    await store.init()
    await store.upsertBatch([{ id: 'a', vector: V_A, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h1' } }])
    await store.upsertBatch([{ id: 'a', vector: V_B, metadata: { path: 'a.ts', startLine: 1, endLine: 1, hash: 'h2' } }])
    expect(await store.count()).toBe(1)
    const results = await store.query(V_B, 5)
    expect(results[0].metadata.hash).toBe('h2')
  })
})
