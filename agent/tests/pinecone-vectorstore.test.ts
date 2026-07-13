import { describe, expect, test, afterEach } from 'bun:test'
import { PineconeVectorStore } from '../src/main/agent/codeindex/vectorstore'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

interface Call {
  url: string
  headers: Record<string, string>
  body: unknown
}

function captureFetch(jsonResponse: unknown, ok = true): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    })
    return {
      ok,
      status: ok ? 200 : 404,
      json: async () => jsonResponse,
      text: async () => JSON.stringify(jsonResponse)
    } as Response
  }) as typeof fetch
  return calls
}

describe('PineconeVectorStore', () => {
  test('init() resolves the data-plane host via the control-plane describe-index endpoint', async () => {
    const calls = captureFetch({ host: 'my-index-abc123.svc.pinecone.io' })
    const store = new PineconeVectorStore('pc-key', 'my-index')
    await store.init()

    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://api.pinecone.io/indexes/my-index')
    expect(calls[0].headers['Api-Key']).toBe('pc-key')
    expect(calls[0].headers['X-Pinecone-Api-Version']).toBeDefined()
  })

  test('init() throws a descriptive error when the index cannot be found', async () => {
    captureFetch({ message: 'not found' }, false)
    const store = new PineconeVectorStore('pc-key', 'missing-index')
    await expect(store.init()).rejects.toThrow(/missing-index/)
  })

  test('upsertBatch batches at 100 vectors per request against the resolved host', async () => {
    const calls = captureFetch({ host: 'my-index-abc123.svc.pinecone.io' })
    const store = new PineconeVectorStore('pc-key', 'my-index')
    await store.init()

    const items = Array.from({ length: 150 }, (_, i) => ({
      id: `id-${i}`,
      vector: [0.1, 0.2],
      metadata: { path: `file${i}.ts`, startLine: 1, endLine: 1, hash: `h${i}` }
    }))
    await store.upsertBatch(items)

    // 1 init call + 2 upsert batches (100 + 50)
    const upsertCalls = calls.filter((c) => c.url.endsWith('/vectors/upsert'))
    expect(upsertCalls.length).toBe(2)
    expect((upsertCalls[0].body as { vectors: unknown[] }).vectors.length).toBe(100)
    expect((upsertCalls[1].body as { vectors: unknown[] }).vectors.length).toBe(50)
    for (const c of upsertCalls) {
      expect(c.url).toBe('https://my-index-abc123.svc.pinecone.io/vectors/upsert')
    }
  })

  test('deleteByPath sends a metadata filter, not explicit ids', async () => {
    const calls = captureFetch({ host: 'my-index-abc123.svc.pinecone.io' })
    const store = new PineconeVectorStore('pc-key', 'my-index')
    await store.init()
    await store.deleteByPath('src/foo.ts')

    const deleteCall = calls.find((c) => c.url.endsWith('/vectors/delete'))
    expect(deleteCall?.body).toEqual({ filter: { path: { $eq: 'src/foo.ts' } } })
  })

  test('query sends vector + topK and maps matches back to QueryMatch shape', async () => {
    captureFetch({ host: 'my-index-abc123.svc.pinecone.io' })
    const store = new PineconeVectorStore('pc-key', 'my-index')
    await store.init()

    // Re-mock fetch for the query call specifically (needs a different response shape).
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          matches: [{ id: 'a', score: 0.9, metadata: { path: 'a.ts', startLine: 1, endLine: 5, hash: 'h1' } }]
        })
      }) as Response) as typeof fetch

    const results = await store.query([0.1, 0.2], 5)
    expect(results).toEqual([{ id: 'a', score: 0.9, metadata: { path: 'a.ts', startLine: 1, endLine: 5, hash: 'h1' } }])
  })

  test('calling a data-plane method before init() throws rather than silently no-op-ing', async () => {
    const store = new PineconeVectorStore('pc-key', 'my-index')
    await expect(store.deleteByIds(['a'])).rejects.toThrow(/init/)
  })
})
