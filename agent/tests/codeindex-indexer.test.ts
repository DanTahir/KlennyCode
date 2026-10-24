import { describe, test, expect, beforeEach, afterEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFullScan, indexFile, removeFile, type ChunkBudget } from '../src/main/agent/codeindex/indexer'
import type { IndexManifest } from '../src/main/agent/codeindex/manifest'
import type { ChunkMetadata, QueryMatch, VectorInput, VectorStore } from '../src/main/agent/codeindex/vectorstore'

/** In-memory VectorStore that records only what the indexer's bookkeeping depends on. */
class FakeStore implements VectorStore {
  rows = new Map<string, ChunkMetadata>()
  async init(): Promise<void> {}
  async upsertBatch(items: Array<{ id: string; vector: VectorInput; metadata: ChunkMetadata }>): Promise<void> {
    for (const it of items) this.rows.set(it.id, it.metadata)
  }
  async deleteByIds(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id)
  }
  async deleteByPath(path: string): Promise<void> {
    for (const [id, m] of this.rows) if (m.path === path) this.rows.delete(id)
  }
  async query(_v: VectorInput, _k: number): Promise<QueryMatch[]> {
    return []
  }
  async clear(): Promise<void> {
    this.rows.clear()
  }
  async count(): Promise<number> {
    return this.rows.size
  }
  async listPaths(): Promise<string[] | null> {
    return [...new Set([...this.rows.values()].map((m) => m.path))].sort()
  }
  async close(): Promise<void> {}
}

// createEmbeddings goes through global fetch; stub it for this file only (mock.module would be
// process-global in Bun and leak into every other suite that imports the OpenRouter client).
const realFetch = globalThis.fetch
let embeddedTexts = 0
globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
  const { input } = JSON.parse(String(init?.body)) as { input: string[] }
  embeddedTexts += input.length
  const data = input.map((t, index) => ({ embedding: [t.length, 1, 0], index }))
  return new Response(JSON.stringify({ data, usage: { prompt_tokens: input.length } }), { status: 200 })
}) as typeof fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

let root: string
let store: FakeStore
let manifest: IndexManifest
let saves: number

function ctx(budget?: ChunkBudget) {
  return {
    root,
    manifest,
    vectorStore: store,
    apiKey: 'k',
    embeddingsModel: 'm',
    budget,
    saveManifest: async () => {
      saves++
    }
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'klenny-indexer-'))
  writeFileSync(join(root, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'b.ts'), 'export const b = 2\n')
  store = new FakeStore()
  manifest = { embeddingsModel: 'm', files: {} }
  saves = 0
  embeddedTexts = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('runFullScan', () => {
  test('indexes eligible files and records them in the manifest', async () => {
    const res = await runFullScan(ctx())
    expect(res).toEqual({ filesTotal: 2, cappedFiles: 0, prunedOrphans: 0, aborted: false })
    expect(Object.keys(manifest.files).sort()).toEqual(['a.ts', 'b.ts'])
    expect(await store.listPaths()).toEqual(['a.ts', 'b.ts'])
    expect(embeddedTexts).toBe(2)
    expect(saves).toBeGreaterThanOrEqual(1)
  })

  test('an unchanged rescan embeds nothing', async () => {
    await runFullScan(ctx())
    embeddedTexts = 0
    await runFullScan(ctx())
    expect(embeddedTexts).toBe(0)
  })

  test('reconciles: re-embeds manifest entries missing from the store and prunes orphans', async () => {
    await runFullScan(ctx())
    // Simulate a fresh store next to an old manifest for a.ts, plus an orphan from an interrupted run.
    await store.deleteByPath('a.ts')
    await store.upsertBatch([{ id: 'ghost-0', vector: [1, 0, 0], metadata: { path: 'ghost.ts', startLine: 1, endLine: 1, hash: 'x' } }])
    embeddedTexts = 0

    const res = await runFullScan(ctx())
    expect(res.prunedOrphans).toBe(1)
    expect(await store.listPaths()).toEqual(['a.ts', 'b.ts'])
    expect(embeddedTexts).toBe(1) // only a.ts, b.ts was intact
  })

  test('drops vectors and manifest entries for files deleted from disk', async () => {
    await runFullScan(ctx())
    unlinkSync(join(root, 'b.ts'))
    const res = await runFullScan(ctx())
    expect(res.filesTotal).toBe(1)
    expect(Object.keys(manifest.files)).toEqual(['a.ts'])
    expect(await store.listPaths()).toEqual(['a.ts'])
  })

  test('chunk budget caps growth and reports skipped files', async () => {
    const budget: ChunkBudget = { total: 0, max: 1, skippedFiles: 0 }
    const res = await runFullScan(ctx(budget))
    expect(res.cappedFiles).toBe(1)
    expect(Object.keys(manifest.files)).toHaveLength(1)
    expect(budget.total).toBe(1)
    expect(await store.count()).toBe(1)
  })

  test('abort stops the scan and still saves the manifest', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await runFullScan({ ...ctx(), signal: ac.signal })
    expect(res.aborted).toBe(true)
    expect(embeddedTexts).toBe(0)
  })
})

describe('indexFile / removeFile', () => {
  test('a file that would exceed the budget is capped, but a shrinking file is still updated', async () => {
    const budget: ChunkBudget = { total: 0, max: 10, skippedFiles: 0 }
    expect(await indexFile(ctx(budget), 'a.ts')).toBe('indexed')
    expect(budget.total).toBe(1)

    budget.max = 1 // now full
    expect(await indexFile(ctx(budget), 'b.ts')).toBe('capped')
    expect(budget.skippedFiles).toBe(1)

    writeFileSync(join(root, 'a.ts'), 'export const a = 42\n') // same chunk count, new content
    expect(await indexFile(ctx(budget), 'a.ts')).toBe('indexed')
    expect(budget.total).toBe(1)
  })

  test('removeFile deletes vectors, the manifest entry and frees budget', async () => {
    const budget: ChunkBudget = { total: 0, max: 10, skippedFiles: 0 }
    await indexFile(ctx(budget), 'a.ts')
    expect(await removeFile(ctx(budget), 'a.ts')).toBe(true)
    expect(manifest.files['a.ts']).toBeUndefined()
    expect(await store.count()).toBe(0)
    expect(budget.total).toBe(0)
    expect(await removeFile(ctx(budget), 'a.ts')).toBe(false)
  })
})
