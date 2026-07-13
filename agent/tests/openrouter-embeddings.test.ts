import { describe, expect, test, afterEach } from 'bun:test'
import { createEmbeddings, fetchModels } from '../src/main/openrouter/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetchOnce(response: { ok: boolean; status?: number; json?: () => Promise<unknown>; text?: () => Promise<string> }): void {
  globalThis.fetch = (async () =>
    ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: response.json ?? (async () => ({})),
      text: response.text ?? (async () => '')
    }) as Response) as typeof fetch
}

describe('createEmbeddings', () => {
  test('posts to /embeddings with model + input, returns embeddings sorted by index', async () => {
    let capturedBody: unknown
    let capturedUrl: string | undefined
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedBody = JSON.parse(String(init?.body))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { embedding: [0.2, 0.3], index: 1 },
            { embedding: [0.1, 0.2], index: 0 }
          ],
          usage: { prompt_tokens: 42 }
        })
      } as Response
    }) as typeof fetch

    const result = await createEmbeddings('test-key', 'qwen/qwen3-embedding-8b', ['hello', 'world'])

    expect(capturedUrl).toContain('/embeddings')
    expect(capturedBody).toMatchObject({ model: 'qwen/qwen3-embedding-8b', input: ['hello', 'world'] })
    // Results must be re-sorted by `index` — the API doesn't guarantee response order matches input order.
    expect(result.embeddings).toEqual([
      [0.1, 0.2],
      [0.2, 0.3]
    ])
    expect(result.promptTokens).toBe(42)
  })

  test('falls back to total_tokens when prompt_tokens is absent', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1], index: 0 }], usage: { total_tokens: 7 } })
    })
    const result = await createEmbeddings('key', 'model', ['x'])
    expect(result.promptTokens).toBe(7)
  })

  test('throws with status + body text on a non-ok response', async () => {
    mockFetchOnce({ ok: false, status: 402, text: async () => 'Insufficient credits' })
    await expect(createEmbeddings('key', 'model', ['x'])).rejects.toThrow(/402/)
  })
})

describe('fetchModels supportsEmbeddings derivation', () => {
  test('a model with output_modalities including "embeddings" is flagged supportsEmbeddings', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'qwen/qwen3-embedding-8b',
            name: 'Qwen3 Embedding 8B',
            context_length: 32000,
            pricing: { prompt: '0.00000001', completion: '0' },
            architecture: { input_modalities: ['text'], output_modalities: ['embeddings'] },
            supported_parameters: []
          }
        ]
      })
    })
    const models = await fetchModels('key', true)
    const model = models.find((m) => m.id === 'qwen/qwen3-embedding-8b')
    expect(model?.supportsEmbeddings).toBe(true)
  })

  test('a normal chat model (output_modalities: ["text"]) is not flagged supportsEmbeddings', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'anthropic/claude-sonnet-5',
            name: 'Claude Sonnet 5',
            context_length: 200000,
            pricing: { prompt: '0.000003', completion: '0.000015' },
            architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
            supported_parameters: ['tools', 'reasoning']
          }
        ]
      })
    })
    const models = await fetchModels('key', true)
    const model = models.find((m) => m.id === 'anthropic/claude-sonnet-5')
    expect(model?.supportsEmbeddings).toBe(false)
  })

  test('a model with no architecture field at all defaults supportsEmbeddings to false (no crash)', async () => {
    mockFetchOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'some/model',
            name: 'Some Model',
            pricing: {},
            supported_parameters: []
          }
        ]
      })
    })
    const models = await fetchModels('key', true)
    expect(models[0].supportsEmbeddings).toBe(false)
  })

  test('merges results from the default listing and the output_modalities=embeddings listing (OpenRouter excludes embedding-only models from the default /models call)', async () => {
    let capturedUrls: string[] = []
    globalThis.fetch = (async (url: string) => {
      capturedUrls.push(String(url))
      const isEmbeddingsQuery = String(url).includes('output_modalities=embeddings')
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: isEmbeddingsQuery
            ? [
                {
                  id: 'qwen/qwen3-embedding-8b',
                  name: 'Qwen3 Embedding 8B',
                  pricing: {},
                  architecture: { output_modalities: ['embeddings'] },
                  supported_parameters: []
                }
              ]
            : [
                {
                  id: 'anthropic/claude-sonnet-5',
                  name: 'Claude Sonnet 5',
                  pricing: {},
                  architecture: { output_modalities: ['text'] },
                  supported_parameters: []
                }
              ]
        })
      } as Response
    }) as typeof fetch

    const models = await fetchModels('key', true)

    expect(capturedUrls.some((u) => u.includes('output_modalities=embeddings'))).toBe(true)
    expect(models.map((m) => m.id).sort()).toEqual(['anthropic/claude-sonnet-5', 'qwen/qwen3-embedding-8b'])
    expect(models.find((m) => m.id === 'qwen/qwen3-embedding-8b')?.supportsEmbeddings).toBe(true)
    expect(models.find((m) => m.id === 'anthropic/claude-sonnet-5')?.supportsEmbeddings).toBe(false)
  })

  test('deduplicates a model id that appears in both listings, keeping the first occurrence', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: 'dual/model',
              name: 'Dual Model',
              pricing: {},
              architecture: { output_modalities: ['embeddings'] },
              supported_parameters: []
            }
          ]
        })
      }) as Response) as typeof fetch

    const models = await fetchModels('key', true)
    expect(models.filter((m) => m.id === 'dual/model')).toHaveLength(1)
  })
})
