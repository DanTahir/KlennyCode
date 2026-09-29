// Coverage for the generate_image tool: the OpenRouter /images client (openrouter/images.ts) and
// the tool wrapper (tools/imagegen.ts).
//
// Two themes drive most of these cases:
//  1. Validation must happen BEFORE the paid API call. Generation costs real money, so a bad
//     extension or an out-of-sandbox destination has to fail without ever hitting the network —
//     several tests assert fetch was never called at all, not merely that the result was ok:false.
//  2. Parameter support is per-model and NOT a superset (verified live: gpt-image-2.5-flare takes
//     aspect_ratio/quality/background but not resolution/output_format), so optional knobs are
//     sent only when explicitly set, and a model that 400s on output_format is retried once and
//     then remembered.
import { describe, expect, test, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // must load before workspace.ts (imports electron) loads anywhere
import { generateImage, sanitizeProviderErrorText } from '../src/main/openrouter/images'
import type { ImageModelInfo, ToolResultPayload } from '@shared/types'
import type { GenerateImageToolArgs } from '../src/main/agent/tools/imagegen'

let workspaceDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-imggen-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-imggen-'))
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
})

/** Minimal but real PNG header — enough for sniffDimensions' signature + IHDR width/height read. */
function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

const PNG = fakePng(8, 8)
const PNG_B64 = PNG.toString('base64')

const originalFetch = globalThis.fetch
let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = []

afterEach(() => {
  globalThis.fetch = originalFetch
  fetchCalls = []
})

/** Records every request and returns the same response for each call. */
function mockImages(
  json: unknown,
  init: { ok?: boolean; status?: number; text?: string } = {}
): void {
  globalThis.fetch = (async (url: string, req?: RequestInit) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(String(req?.body ?? '{}')) })
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => json,
      text: async () => init.text ?? ''
    } as Response
  }) as typeof fetch
}

/** A successful single-image response. */
function okImage(over: { b64?: string; mediaType?: string; usage?: unknown } = {}): unknown {
  return {
    created: 1,
    data: [{ b64_json: over.b64 ?? PNG_B64, media_type: over.mediaType ?? 'image/png' }],
    ...(over.usage !== undefined ? { usage: over.usage } : {})
  }
}

/** Fetch that records the attempt and throws — used to prove no API call was made. */
function forbidFetch(): void {
  globalThis.fetch = (async (url: string) => {
    fetchCalls.push({ url: String(url), body: {} })
    throw new Error('fetch must not be called')
  }) as typeof fetch
}

describe('generateImage (OpenRouter /images client)', () => {
  test('posts to /images and sends only the knobs that were explicitly set', async () => {
    mockImages(okImage())
    await generateImage({
      apiKey: 'k',
      model: 'test/plain',
      prompt: 'a corgi',
      aspectRatio: '16:9',
      outputFormat: 'png'
    })

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].url).toContain('/images')
    expect(fetchCalls[0].body).toMatchObject({
      model: 'test/plain',
      prompt: 'a corgi',
      aspect_ratio: '16:9',
      output_format: 'png'
    })
    // Unset knobs must be absent entirely, not sent as undefined/null — support varies per model.
    expect(fetchCalls[0].body.resolution).toBeUndefined()
    expect(fetchCalls[0].body.quality).toBeUndefined()
    expect(fetchCalls[0].body.background).toBeUndefined()
  })

  test('parses data[0].b64_json, media_type and usage', async () => {
    mockImages(okImage({ usage: { cost: 0.13, prompt_tokens: 5, completion_tokens: 2 } }))
    const r = await generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p' })

    expect(r.buffer.equals(PNG)).toBe(true)
    expect(r.mimeType).toBe('image/png')
    expect(r.costUsd).toBe(0.13)
    expect(r.promptTokens).toBe(5)
    expect(r.completionTokens).toBe(2)
  })

  test('defaults mimeType to image/png and cost/tokens to 0 when the response omits them', async () => {
    // Verified live: image model records carry no pricing, and usage.cost can be absent entirely.
    mockImages({ data: [{ b64_json: PNG_B64 }] })
    const r = await generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p' })
    expect(r.mimeType).toBe('image/png')
    expect(r.costUsd).toBe(0)
    expect(r.promptTokens).toBe(0)
  })

  test('throws on an empty data array', async () => {
    mockImages({ data: [] })
    await expect(generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p' })).rejects.toThrow(
      /no image data/i
    )
  })

  test('throws when the entry carries no base64 payload', async () => {
    mockImages({ data: [{ media_type: 'image/png' }] })
    await expect(generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p' })).rejects.toThrow(
      /no base64/i
    )
  })

  test('throws on an undecodable base64 payload', async () => {
    // Buffer.from silently DROPS invalid base64 chars instead of throwing, so non-empty input
    // decoding to zero bytes is the only reliable signal that the payload was garbage.
    mockImages({ data: [{ b64_json: '!!!!' }] })
    await expect(generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p' })).rejects.toThrow(
      /undecodable/i
    )
  })

  test('throws with the status and body text on a non-ok response', async () => {
    mockImages({}, { ok: false, status: 402, text: 'Insufficient credits' })
    await expect(generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p' })).rejects.toThrow(
      /402/
    )
  })

  test('a 400 mentioning output_format is retried once without the field, then remembered per model', async () => {
    const REJECTOR = 'test/output-format-rejector'
    let call = 0
    globalThis.fetch = (async (url: string, req?: RequestInit) => {
      call++
      fetchCalls.push({ url: String(url), body: JSON.parse(String(req?.body ?? '{}')) })
      if (call === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({}),
          text: async () => 'unsupported parameter: output_format'
        } as Response
      }
      return { ok: true, status: 200, json: async () => okImage(), text: async () => '' } as Response
    }) as typeof fetch

    const r = await generateImage({ apiKey: 'k', model: REJECTOR, prompt: 'p', outputFormat: 'png' })
    expect(r.buffer.length).toBeGreaterThan(0)
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0].body.output_format).toBe('png')
    expect(fetchCalls[1].body.output_format).toBeUndefined()

    // Remembered: a later call for the same model skips the field up front rather than paying for
    // a failed round trip every single time (the whole point of the process-lived Set).
    fetchCalls = []
    mockImages(okImage())
    await generateImage({ apiKey: 'k', model: REJECTOR, prompt: 'p', outputFormat: 'png' })
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].body.output_format).toBeUndefined()
  })

  test('a 400 that does NOT mention output_format is not retried', async () => {
    mockImages({}, { ok: false, status: 400, text: 'content policy violation' })
    await expect(
      generateImage({ apiKey: 'k', model: 'test/other', prompt: 'p', outputFormat: 'png' })
    ).rejects.toThrow(/400/)
    expect(fetchCalls).toHaveLength(1)
  })

  test('reports a timeout as a timeout rather than a bare abort', async () => {
    globalThis.fetch = ((_url: string, req?: RequestInit) =>
      new Promise((_resolve, reject) => {
        req?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as unknown as typeof fetch

    await expect(
      generateImage({ apiKey: 'k', model: 'test/slow', prompt: 'p', timeoutMs: 10 })
    ).rejects.toThrow(/timed out/i)
  })

  test('an already-aborted caller signal short-circuits before any request', async () => {
    forbidFetch()
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p', signal: ctrl.signal })
    ).rejects.toThrow()
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('generateImageTool', () => {
  async function run(args: Record<string, unknown>, model = 'test/plain'): Promise<ToolResultPayload> {
    const { generateImageTool } = await import('../src/main/agent/tools/index')
    return generateImageTool(args, { apiKey: 'k', model })
  }

  test('requires a path and a prompt, without calling the API', async () => {
    forbidFetch()
    expect((await run({ prompt: 'p' })).error).toBe('invalid_args')
    expect((await run({ path: 'a.png' })).error).toBe('invalid_args')
    // Whitespace-only counts as absent.
    expect((await run({ path: '   ', prompt: 'p' })).error).toBe('invalid_args')
    expect(fetchCalls).toHaveLength(0)
  })

  test('reports not_configured when no image model is set', async () => {
    forbidFetch()
    const r = await run({ path: 'a.png', prompt: 'p' }, '')
    expect(r.ok).toBe(false)
    expect(r.error).toBe('not_configured')
    expect(fetchCalls).toHaveLength(0)
  })

  test('rejects extensions OpenRouter cannot generate, before spending anything', async () => {
    forbidFetch()
    // .gif is readable by read_image but is NOT a generatable output_format — accepting it would
    // charge the user and then fail provider-side.
    expect((await run({ path: 'a.gif', prompt: 'p' })).error).toBe('unsupported_type')
    expect((await run({ path: 'a.bmp', prompt: 'p' })).error).toBe('unsupported_type')
    expect((await run({ path: 'noextension', prompt: 'p' })).error).toBe('unsupported_type')
    expect(fetchCalls).toHaveLength(0)
  })

  test('rejects a destination outside the sandbox before spending anything', async () => {
    forbidFetch()
    const r = await run({ path: '../../etc/evil.png', prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(['invalid_path', 'outside_workspace']).toContain(r.error)
    expect(fetchCalls).toHaveLength(0)
  })

  test('writes the bytes to disk (creating parent dirs) and returns a uiOnly data URL', async () => {
    mockImages(okImage({ usage: { cost: 0.04 } }))
    const r = await run({ path: 'assets/hero.png', prompt: 'a corgi' })

    expect(r.ok).toBe(true)
    const data = r.data as Record<string, unknown>
    expect(data.path).toBe('assets/hero.png')
    expect(data.width).toBe(8)
    expect(data.height).toBe(8)
    expect(data.costUsd).toBe(0.04)
    // dataUrl + imageUiOnly are what loop.ts lifts into a uiOnly ImageBlock (thumbnail in chat,
    // never re-uploaded to the model) and then deletes from the persisted payload.
    expect(String(data.dataUrl).startsWith('data:image/png;base64,')).toBe(true)
    expect(data.imageUiOnly).toBe(true)

    const onDisk = await readFile(join(workspaceDir, 'assets', 'hero.png'))
    expect(onDisk.equals(PNG)).toBe(true)
    expect(r.summary).toContain('8\u00d78')
    expect(r.summary).toContain('$0.0400')
  })

  test('derives output_format from the extension, case-insensitively', async () => {
    mockImages(okImage({ mediaType: 'image/jpeg' }))
    const r = await run({ path: 'OUT.JPG', prompt: 'p' })
    expect(r.ok).toBe(true)
    expect(fetchCalls[0].body.output_format).toBe('jpeg')
  })

  test('calls out a mimeType/extension mismatch instead of silently lying about the file', async () => {
    mockImages(okImage({ mediaType: 'image/jpeg' }))
    const r = await run({ path: 'mismatch.png', prompt: 'p' })
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('despite the .png extension')
  })

  test('distinguishes a failed write from a failed generation, preserving the cost already spent', async () => {
    // Parent path is a regular file, so mkdir fails after the money is already gone.
    await writeFile(join(workspaceDir, 'blocker'), 'not a directory')
    mockImages(okImage({ usage: { cost: 0.02 } }))

    const r = await run({ path: 'blocker/x.png', prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('write_failed')
    expect(r.summary).toContain('Generated the image but failed to write')
    expect((r.data as { costUsd: number }).costUsd).toBe(0.02)
  })

  test('surfaces a generation failure as generation_failed', async () => {
    mockImages({}, { ok: false, status: 402, text: 'Insufficient credits' })
    const r = await run({ path: 'fail.png', prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('generation_failed')
    expect(String((r.data as { detail: string }).detail)).toContain('402')
  })
})

// ---------- Reference images (image-to-image / editing) ----------
//
// Three invariants: (1) the wire shape is OpenRouter's documented
// `[{ type: 'image_url', image_url: { url } }]`; (2) every local failure, and every explicit
// catalog refusal, happens BEFORE the paid call; (3) inlined base64 never lands in the tool
// result, which persists to the session log and is replayed to the model every later turn.

/** Minimal JPEG signature (SOI + APP0 start), enough for the reference MIME sniff. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])

function imageModel(over: Partial<ImageModelInfo> = {}): ImageModelInfo {
  return {
    id: 'test/refs',
    name: 'Test refs',
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    supportedParameters: {},
    supportsStreaming: false,
    requiresInputReferences: false,
    pinned: false,
    ...over
  }
}

describe('generateImage \u2014 input_references wire shape', () => {
  test('sends references in the documented image_url object shape, in order', async () => {
    mockImages(okImage())
    await generateImage({
      apiKey: 'k',
      model: 'test/plain',
      prompt: 'p',
      inputReferences: ['https://example.com/a.png', 'data:image/png;base64,QUFB']
    })
    expect(fetchCalls[0].body.input_references).toEqual([
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUFB' } }
    ])
  })

  test('omits input_references entirely when none are given', async () => {
    mockImages(okImage())
    await generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p', inputReferences: [] })
    expect('input_references' in fetchCalls[0].body).toBe(false)
  })

  test('the output_format recovery retry drops output_format but KEEPS the references', async () => {
    // Dropping references on a retry would silently turn an edit into a fresh generation and
    // charge for it, so only output_format may be removed.
    let call = 0
    globalThis.fetch = (async (url: string, req?: RequestInit) => {
      call++
      fetchCalls.push({ url: String(url), body: JSON.parse(String(req?.body ?? '{}')) })
      if (call === 1) {
        return {
          ok: false,
          status: 400,
          json: async () => ({}),
          text: async () => 'unsupported parameter: output_format'
        } as Response
      }
      return { ok: true, status: 200, json: async () => okImage(), text: async () => '' } as Response
    }) as typeof fetch

    await generateImage({
      apiKey: 'k',
      model: 'test/output-format-rejector-with-refs',
      prompt: 'p',
      outputFormat: 'png',
      inputReferences: ['https://example.com/a.png']
    })
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[1].body.output_format).toBeUndefined()
    expect(fetchCalls[1].body.input_references).toEqual(fetchCalls[0].body.input_references)
  })

  test('a provider error that echoes an inlined reference is redacted and capped', async () => {
    const blob = 'A'.repeat(50_000)
    mockImages({}, { ok: false, status: 422, text: `bad input: {"url":"data:image/png;base64,${blob}"}` })
    const err = await generateImage({ apiKey: 'k', model: 'test/plain', prompt: 'p' }).catch((e) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('422')
    expect(err.message).toContain('data:image/png;base64,<omitted>')
    expect(err.message).not.toContain('AAAAAAAAAA')
  })

  test('sanitizeProviderErrorText hard-caps long plain text', () => {
    const out = sanitizeProviderErrorText('x'.repeat(5000))
    expect(out.length).toBeLessThan(2100)
    expect(out).toContain('[truncated]')
    expect(sanitizeProviderErrorText('short')).toBe('short')
  })
})

describe('generateImageTool \u2014 reference_images', () => {
  beforeAll(async () => {
    await writeFile(join(workspaceDir, 'ref.png'), PNG)
    // JPEG bytes behind a .png name: must be sent with the SNIFFED mime type.
    await writeFile(join(workspaceDir, 'ref-mislabeled.png'), JPEG)
    await writeFile(join(workspaceDir, 'not-an-image.png'), 'plain text, not a PNG')
  })

  async function runRefs(
    args: Record<string, unknown>,
    lookupModel: (id: string) => Promise<ImageModelInfo | undefined> = async () => imageModel()
  ): Promise<ToolResultPayload> {
    const { generateImageTool } = await import('../src/main/agent/tools/index')
    return generateImageTool(args as GenerateImageToolArgs, { apiKey: 'k', model: 'test/refs', lookupModel })
  }

  test('inlines local files as data URLs (sniffed mime), passes URLs through, and keeps base64 out of the result', async () => {
    mockImages(okImage())
    const refs = ['ref-mislabeled.png', 'https://example.com/b.webp']
    const r = await runRefs({ path: 'out/edit.png', prompt: 'make it blue', reference_images: refs })

    expect(r.ok).toBe(true)
    const sent = fetchCalls[0].body.input_references as Array<{ type: string; image_url: { url: string } }>
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${JPEG.toString('base64')}` } })
    expect(sent[1].image_url.url).toBe('https://example.com/b.webp')

    const data = r.data as Record<string, unknown>
    expect(data.referenceImages).toEqual(refs)
    // dataUrl is the OUTPUT thumbnail, which loop.ts strips before persisting; everything else
    // is persisted and must not carry any reference bytes.
    const { dataUrl: _thumbnail, ...persisted } = data
    expect(JSON.stringify(persisted)).not.toContain(JPEG.toString('base64'))
    expect(JSON.stringify(persisted)).not.toContain('data:image/')
    expect(r.summary).toContain('2 reference images')
  })

  test('tolerates a single bare string and a JSON-stringified array', async () => {
    mockImages(okImage())
    expect((await runRefs({ path: 's1.png', prompt: 'p', reference_images: 'ref.png' })).ok).toBe(true)
    expect((await runRefs({ path: 's2.png', prompt: 'p', reference_images: '["ref.png","ref.png"]' })).ok).toBe(true)
    expect(fetchCalls[0].body.input_references as unknown[]).toHaveLength(1)
    expect(fetchCalls[1].body.input_references as unknown[]).toHaveLength(2)
  })

  test('with no references, the catalog is never consulted and the request is unchanged', async () => {
    let lookups = 0
    const lookup = async () => {
      lookups++
      return imageModel()
    }
    mockImages(okImage())
    expect((await runRefs({ path: 'plain1.png', prompt: 'p' }, lookup)).ok).toBe(true)
    expect((await runRefs({ path: 'plain2.png', prompt: 'p', reference_images: [] }, lookup)).ok).toBe(true)
    expect(lookups).toBe(0)
    expect(fetchCalls).toHaveLength(2)
    expect('input_references' in fetchCalls[0].body).toBe(false)
    expect('input_references' in fetchCalls[1].body).toBe(false)
  })

  test('every local reference problem fails before any API call', async () => {
    forbidFetch()
    const cases: Array<[unknown, string]> = [
      [['missing.png'], 'not_found'],
      [['anim.gif'], 'unsupported_type'],
      [['not-an-image.png'], 'unsupported_type'],
      [['ftp://example.com/a.png'], 'invalid_args'],
      [[42], 'invalid_args'],
      [{ path: 'ref.png' }, 'invalid_args'],
      ['[not json', 'invalid_args'],
      [Array(17).fill('ref.png'), 'invalid_args']
    ]
    for (const [reference_images, error] of cases) {
      const r = await runRefs({ path: 'never.png', prompt: 'p', reference_images })
      expect({ reference_images, error: r.error }).toEqual({ reference_images, error })
    }
    expect(fetchCalls).toHaveLength(0)
  })

  test('an inline data URL is refused without echoing its payload anywhere in the result', async () => {
    forbidFetch()
    const payload = 'Q'.repeat(4000)
    const r = await runRefs({ path: 'never.png', prompt: 'p', reference_images: [`data:image/png;base64,${payload}`] })
    expect(r.error).toBe('invalid_args')
    expect(JSON.stringify(r)).not.toContain('QQQQQQQQ')
    expect(fetchCalls).toHaveLength(0)
  })

  test('enforces the per-file and total size caps before any API call', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1)
    PNG.copy(big, 0)
    await writeFile(join(workspaceDir, 'huge.png'), big)
    const seven = Buffer.alloc(7 * 1024 * 1024)
    PNG.copy(seven, 0)
    await writeFile(join(workspaceDir, 'seven.png'), seven)

    forbidFetch()
    expect((await runRefs({ path: 'never.png', prompt: 'p', reference_images: ['huge.png'] })).error).toBe('too_large')
    // 3 x 7 MB = 21 MB, over the 20 MB aggregate cap even though each file is individually fine.
    const total = await runRefs({ path: 'never.png', prompt: 'p', reference_images: ['seven.png', 'seven.png', 'seven.png'] })
    expect(total.error).toBe('too_large')
    expect(fetchCalls).toHaveLength(0)
  })

  test('refuses before spending when the catalog explicitly rules the references out', async () => {
    forbidFetch()
    const noRefs = imageModel({ supportedParameters: { input_references: { type: 'range', min: 0, max: 0 } } })
    const textOnly = imageModel({ inputModalities: ['text'] })
    const maxOne = imageModel({ supportedParameters: { input_references: { type: 'range', min: 0, max: 1 } } })

    const r1 = await runRefs({ path: 'never.png', prompt: 'p', reference_images: ['ref.png'] }, async () => noRefs)
    const r2 = await runRefs({ path: 'never.png', prompt: 'p', reference_images: ['ref.png'] }, async () => textOnly)
    const r3 = await runRefs({ path: 'never.png', prompt: 'p', reference_images: ['ref.png', 'ref.png'] }, async () => maxOne)
    for (const r of [r1, r2, r3]) expect(r.error).toBe('unsupported_references')
    expect(String((r3.data as { detail: string }).detail)).toContain('at most 1')
    expect(fetchCalls).toHaveLength(0)
  })

  test('proceeds when the catalog is silent, unknown or failing (the provider stays the authority)', async () => {
    mockImages(okImage())
    const args = { path: 'ok.png', prompt: 'p', reference_images: ['ref.png'] }
    // meta/muse-image shape, verified live: image input modality but EMPTY supported_parameters.
    expect((await runRefs(args, async () => imageModel({ supportedParameters: {} }))).ok).toBe(true)
    expect((await runRefs(args, async () => undefined)).ok).toBe(true)
    expect(
      (
        await runRefs(args, async () => {
          throw new Error('catalog down')
        })
      ).ok
    ).toBe(true)
    expect(fetchCalls).toHaveLength(3)
  })
})

describe('referenceSupportProblem', () => {
  test('checks the declared min/max range only when references are actually given', async () => {
    const { referenceSupportProblem } = await import('../src/main/agent/tools/imagegen')
    const minTwo = imageModel({ supportedParameters: { input_references: { type: 'range', min: 2, max: 10 } } })
    expect(referenceSupportProblem(minTwo, 1)).toContain('at least 2')
    expect(referenceSupportProblem(minTwo, 2)).toBeNull()
    expect(referenceSupportProblem(minTwo, 0)).toBeNull()
    expect(referenceSupportProblem(undefined, 5)).toBeNull()
  })
})

describe('generate_image approval preview', () => {
  test('lists references as uploads, masking inline data URLs', async () => {
    const { previewMutatingTool } = await import('../src/main/agent/orchestrator/approval-previews')
    const p = await previewMutatingTool('generate_image', {
      path: 'x.png',
      prompt: 'p',
      reference_images: ['a.png', 'data:image/png;base64,QUFBQUFB']
    })
    const command = String((p.extra as { command?: string }).command)
    expect(command).toContain('references (uploaded to the image provider): a.png, <inline data URL>')
    expect(command).not.toContain('QUFBQUFB')
  })
})
