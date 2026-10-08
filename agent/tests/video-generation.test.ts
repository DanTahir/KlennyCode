// Coverage for the generate_video tool: the OpenRouter /videos client (openrouter/videos.ts) and
// the tool wrapper (tools/videogen.ts).
//
// Themes:
//  1. Validation happens BEFORE the paid submit. Several tests assert fetch was never called.
//  2. The async job lifecycle (submit -> poll -> download) must tolerate transient poll failures,
//     fail fast on auth/not-found, honor the overall deadline, and report whether the job had
//     already been submitted (i.e. may have been billed) on every failure.
//  3. The API key is only ever sent to https://openrouter.ai, even if a response names another host.
import { describe, expect, test, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // must load before workspace.ts (imports electron) loads anywhere
import {
  generateVideo,
  fetchVideoModels,
  sniffVideoMime,
  isTrustedUrl,
  VideoGenerationError
} from '../src/main/openrouter/videos'
import type { ToolResultPayload, VideoModelInfo } from '@shared/types'
import type { GenerateVideoToolArgs } from '../src/main/agent/tools/videogen'

let workspaceDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-vidgen-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-vidgen-'))
  electronMockState.userDataDir = userDataDir
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null)
  await rm(workspaceDir, { recursive: true, force: true })
})

function fakePng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0)
  buf.writeUInt32BE(13, 8)
  buf.write('IHDR', 12, 'ascii')
  buf.writeUInt32BE(width, 16)
  buf.writeUInt32BE(height, 20)
  return buf
}

/** Minimal ISO-BMFF header: size + 'ftyp' + 'isom' brand. */
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(12)])

interface Call {
  url: string
  method: string
  auth?: string
  body?: Record<string, unknown>
}

const originalFetch = globalThis.fetch
let calls: Call[] = []

afterEach(() => {
  globalThis.fetch = originalFetch
  calls = []
})

interface FakeResp {
  status?: number
  json?: unknown
  text?: string
  bytes?: Buffer
  headers?: Record<string, string>
}

function resp(r: FakeResp): unknown {
  const status = r.status ?? 200
  const headers = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => r.json,
    text: async () => r.text ?? JSON.stringify(r.json ?? ''),
    arrayBuffer: async () => {
      const b = r.bytes ?? Buffer.alloc(0)
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    },
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null }
  }
}

/** Routes by method + URL: POST /videos -> submit, GET .../content -> download, other GET -> next poll. */
function mockVideoApi(opts: { submit?: FakeResp; polls: FakeResp[]; content?: FakeResp }): void {
  let pollIndex = 0
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const h = (init?.headers ?? {}) as Record<string, string>
    const call: Call = { url: String(url), method, auth: h.Authorization }
    if (init?.body) call.body = JSON.parse(String(init.body))
    calls.push(call)
    if (method === 'POST') {
      return resp(opts.submit ?? { status: 202, json: { id: 'job1', polling_url: 'https://openrouter.ai/api/v1/videos/job1', status: 'pending' } })
    }
    if (String(url).includes('/content')) {
      return resp(opts.content ?? { bytes: MP4, headers: { 'content-type': 'video/mp4' } })
    }
    const p = opts.polls[Math.min(pollIndex, opts.polls.length - 1)]
    pollIndex++
    return resp(p)
  }) as unknown as typeof fetch
}

const COMPLETED: FakeResp = {
  json: {
    id: 'job1',
    generation_id: 'gen-1',
    status: 'completed',
    unsigned_urls: ['https://openrouter.ai/api/v1/videos/job1/content?index=0'],
    usage: { cost: 0.32 }
  }
}
const noSleep = async (): Promise<void> => {}
const fast = { pollScheduleMs: [0], sleep: noSleep }

describe('generateVideo (client)', () => {
  test('submits, polls to completion and downloads, sending knobs only when set', async () => {
    mockVideoApi({ polls: [{ json: { status: 'in_progress' } }, COMPLETED] })
    const statuses: string[] = []
    const r = await generateVideo({
      apiKey: 'sk-test',
      model: 'google/veo-3.1-lite',
      prompt: 'a corgi surfing',
      duration: 8,
      frameImages: [{ url: 'data:image/png;base64,AAAA', frameType: 'first_frame' }],
      onStatus: (u) => statuses.push(u.status),
      ...fast
    })
    expect(r.costUsd).toBe(0.32)
    expect(r.jobId).toBe('job1')
    expect(r.generationId).toBe('gen-1')
    expect(r.mimeType).toBe('video/mp4')
    expect(r.buffer.equals(MP4)).toBe(true)
    expect(statuses).toEqual(['pending', 'in_progress', 'completed'])

    const submit = calls[0]
    expect(submit.method).toBe('POST')
    expect(submit.url).toBe('https://openrouter.ai/api/v1/videos')
    expect(submit.body).toEqual({
      model: 'google/veo-3.1-lite',
      prompt: 'a corgi surfing',
      duration: 8,
      frame_images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' }, frame_type: 'first_frame' }]
    })
    expect(calls.every((c) => c.auth === 'Bearer sk-test')).toBe(true)
    expect(calls.at(-1)!.url).toBe('https://openrouter.ai/api/v1/videos/job1/content?index=0')
  })

  test('sends input_references for reference images', async () => {
    mockVideoApi({ polls: [COMPLETED] })
    await generateVideo({ apiKey: 'k', model: 'm', prompt: 'p', inputReferences: ['https://x.test/a.png'], ...fast })
    expect(calls[0].body!.input_references).toEqual([{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }])
    expect(calls[0].body!.frame_images).toBeUndefined()
  })

  test('never sends the API key to a non-openrouter host named in a response', async () => {
    mockVideoApi({
      submit: { status: 202, json: { id: 'job1', polling_url: 'https://evil.test/poll', status: 'pending' } },
      polls: [{ json: { status: 'completed', unsigned_urls: ['https://evil.test/video.mp4'], usage: { cost: 0.1 } } }]
    })
    await generateVideo({ apiKey: 'k', model: 'm', prompt: 'p', ...fast })
    expect(calls.some((c) => c.url.includes('evil.test'))).toBe(false)
    expect(calls[1].url).toBe('https://openrouter.ai/api/v1/videos/job1')
    expect(calls[2].url).toBe('https://openrouter.ai/api/v1/videos/job1/content?index=0')
  })

  test('isTrustedUrl only accepts https://openrouter.ai', () => {
    expect(isTrustedUrl('https://openrouter.ai/api/v1/videos/x')).toBe(true)
    expect(isTrustedUrl('http://openrouter.ai/api/v1/videos/x')).toBe(false)
    expect(isTrustedUrl('https://openrouter.ai.evil.test/x')).toBe(false)
    expect(isTrustedUrl(42)).toBe(false)
  })

  test('a submit rejection is reported as NOT submitted', async () => {
    mockVideoApi({ submit: { status: 400, text: 'bad duration' }, polls: [] })
    const err = await generateVideo({ apiKey: 'k', model: 'm', prompt: 'p', ...fast }).catch((e) => e)
    expect(err).toBeInstanceOf(VideoGenerationError)
    expect(err.submitted).toBe(false)
    expect(err.message).toContain('400')
    expect(err.message).toContain('bad duration')
  })

  test('a failed job carries the job id, the provider message, and submitted=true', async () => {
    mockVideoApi({ polls: [{ json: { status: 'failed', error: { message: 'content policy' } } }] })
    const err = await generateVideo({ apiKey: 'k', model: 'm', prompt: 'p', ...fast }).catch((e) => e)
    expect(err).toBeInstanceOf(VideoGenerationError)
    expect(err.submitted).toBe(true)
    expect(err.jobId).toBe('job1')
    expect(err.message).toContain('content policy')
  })

  test('tolerates transient poll failures', async () => {
    mockVideoApi({ polls: [{ status: 500 }, { status: 429 }, COMPLETED] })
    const r = await generateVideo({ apiKey: 'k', model: 'm', prompt: 'p', ...fast })
    expect(r.costUsd).toBe(0.32)
  })

  test('gives up after repeated consecutive poll failures', async () => {
    mockVideoApi({ polls: [{ status: 503 }] })
    const err = await generateVideo({ apiKey: 'k', model: 'm', prompt: 'p', ...fast }).catch((e) => e)
    expect(err).toBeInstanceOf(VideoGenerationError)
    expect(err.message).toContain('Lost track of video job job1')
    expect(err.submitted).toBe(true)
    expect(calls.filter((c) => c.method === 'GET').length).toBe(5)
  })

  test('fails immediately on a 401 poll', async () => {
    mockVideoApi({ polls: [{ status: 401, text: 'unauthorized' }] })
    const err = await generateVideo({ apiKey: 'k', model: 'm', prompt: 'p', ...fast }).catch((e) => e)
    expect(err).toBeInstanceOf(VideoGenerationError)
    expect(calls.filter((c) => c.method === 'GET').length).toBe(1)
  })

  test('honors the overall deadline', async () => {
    mockVideoApi({ polls: [{ json: { status: 'pending' } }] })
    let t = 0
    const err = await generateVideo({
      apiKey: 'k',
      model: 'm',
      prompt: 'p',
      pollScheduleMs: [10_000],
      timeoutMs: 30_000,
      now: () => t,
      sleep: async (ms) => {
        t += ms
      }
    }).catch((e) => e)
    expect(err).toBeInstanceOf(VideoGenerationError)
    expect(err.message).toContain('did not finish')
    expect(err.submitted).toBe(true)
  })

  test('propagates a caller abort as an AbortError', async () => {
    mockVideoApi({ polls: [{ json: { status: 'pending' } }] })
    const controller = new AbortController()
    const err = await generateVideo({
      apiKey: 'k',
      model: 'm',
      prompt: 'p',
      pollScheduleMs: [10],
      signal: controller.signal,
      onStatus: () => controller.abort()
    }).catch((e) => e)
    expect(err.name).toBe('AbortError')
  })

  test('a download failure after completion is reported as submitted', async () => {
    mockVideoApi({ polls: [COMPLETED], content: { status: 502, text: 'gateway' } })
    const err = await generateVideo({ apiKey: 'k', model: 'm', prompt: 'p', ...fast }).catch((e) => e)
    expect(err).toBeInstanceOf(VideoGenerationError)
    expect(err.submitted).toBe(true)
    expect(err.message).toContain('downloading it failed')
  })

  test('sniffVideoMime recognizes mp4, quicktime and webm', () => {
    expect(sniffVideoMime(MP4)).toBe('video/mp4')
    const qt = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ', 'ascii'), Buffer.alloc(8)])
    expect(sniffVideoMime(qt)).toBe('video/quicktime')
    expect(sniffVideoMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0]))).toBe('video/webm')
    expect(sniffVideoMime(Buffer.from('not a video'))).toBeUndefined()
  })
})

describe('fetchVideoModels', () => {
  test('parses the catalog, flags source-media models, pins the default first', async () => {
    globalThis.fetch = (async () =>
      resp({
        json: {
          data: [
            {
              id: 'black-forest-labs/flux-video-edit',
              name: 'Flux Video Edit',
              supported_durations: null,
              supported_frame_images: null
            },
            {
              id: 'alpha/zed',
              name: 'Alpha Zed',
              supported_durations: [5, 10],
              supported_resolutions: ['720p'],
              supported_frame_images: ['first_frame'],
              pricing_skus: { per_second: '0.05' }
            },
            {
              id: 'google/veo-3.1-lite',
              name: 'Veo 3.1 Lite',
              supported_durations: [4, 6, 8],
              supported_frame_images: ['first_frame', 'last_frame'],
              generate_audio: true
            }
          ]
        }
      })) as unknown as typeof fetch
    const models = await fetchVideoModels('k', true)
    expect(models[0].id).toBe('google/veo-3.1-lite')
    expect(models[0].pinned).toBe(true)
    expect(models[0].generateAudio).toBe(true)
    const edit = models.find((m) => m.id === 'black-forest-labs/flux-video-edit')!
    expect(edit.requiresSourceMedia).toBe(true)
    const zed = models.find((m) => m.id === 'alpha/zed')!
    expect(zed.requiresSourceMedia).toBe(false)
    expect(zed.supportedDurations).toEqual([5, 10])
    expect(zed.pricingSkus).toEqual({ per_second: '0.05' })
  })
})

function model(over: Partial<VideoModelInfo> = {}): VideoModelInfo {
  return {
    id: 'google/veo-3.1-lite',
    name: 'Veo 3.1 Lite',
    supportedDurations: [4, 6, 8],
    supportedResolutions: ['720p', '1080p'],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedSizes: null,
    supportedFrameImages: ['first_frame', 'last_frame'],
    generateAudio: true,
    seed: true,
    pricingSkus: {},
    allowedPassthroughParameters: [],
    requiresSourceMedia: false,
    pinned: true,
    ...over
  }
}

describe('videoParameterProblems', () => {
  test('refuses values outside a non-empty catalog list', async () => {
    const { videoParameterProblems } = await import('../src/main/agent/tools/videogen')
    const problems = videoParameterProblems(model(), {
      duration: 5,
      resolution: '4K',
      aspectRatio: '1:1',
      frameTypes: []
    })
    expect(problems.length).toBe(3)
    expect(problems[0]).toContain('4, 6, 8')
  })

  test('is permissive for null lists, unknown models and case differences', async () => {
    const { videoParameterProblems } = await import('../src/main/agent/tools/videogen')
    expect(videoParameterProblems(undefined, { duration: 99, frameTypes: ['last_frame'] })).toEqual([])
    expect(
      videoParameterProblems(model({ supportedDurations: null, supportedFrameImages: null }), {
        duration: 99,
        size: '1280x720',
        frameTypes: ['first_frame', 'last_frame']
      })
    ).toEqual([])
    expect(videoParameterProblems(model(), { resolution: '1080P', frameTypes: [] })).toEqual([])
  })

  test('refuses a last_frame the model does not take', async () => {
    const { videoParameterProblems } = await import('../src/main/agent/tools/videogen')
    const problems = videoParameterProblems(model({ supportedFrameImages: ['first_frame'] }), {
      frameTypes: ['first_frame', 'last_frame']
    })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('last_frame')
  })
})

async function runTool(args: GenerateVideoToolArgs, extra: Record<string, unknown> = {}): Promise<ToolResultPayload> {
  const { generateVideoTool } = await import('../src/main/agent/tools/videogen')
  return generateVideoTool(args, {
    apiKey: 'sk-test',
    model: 'google/veo-3.1-lite',
    lookupModel: async () => model(),
    client: fast,
    ...extra
  })
}

describe('generate_video tool', () => {
  test('rejects a non-.mp4 destination without calling the API', async () => {
    mockVideoApi({ polls: [COMPLETED] })
    const r = await runTool({ path: 'clip.mov', prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('unsupported_type')
    expect(calls).toHaveLength(0)
  })

  test('rejects a destination outside the workspace without calling the API', async () => {
    mockVideoApi({ polls: [COMPLETED] })
    const outside = join(tmpdir(), 'klenny-not-the-workspace', 'clip.mp4')
    const r = await runTool({ path: outside, prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('outside_workspace')
    expect(calls).toHaveLength(0)
  })

  test('refuses frames combined with reference images, before spending', async () => {
    mockVideoApi({ polls: [COMPLETED] })
    const r = await runTool({
      path: 'clip.mp4',
      prompt: 'p',
      first_frame: 'https://x.test/a.png',
      reference_images: ['https://x.test/b.png']
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_args')
    expect(calls).toHaveLength(0)
  })

  test('refuses an unsupported duration from the catalog, before spending', async () => {
    mockVideoApi({ polls: [COMPLETED] })
    const r = await runTool({ path: 'clip.mp4', prompt: 'p', duration: 5 })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('unsupported_parameters')
    expect(calls).toHaveLength(0)
  })

  test('rejects malformed knobs', async () => {
    mockVideoApi({ polls: [COMPLETED] })
    const r = await runTool({ path: 'clip.mp4', prompt: 'p', duration: 'eight' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_args')
    expect(calls).toHaveLength(0)
  })

  test('generates with a local first frame, writes the file, keeps data URLs out of the result', async () => {
    await writeFile(join(workspaceDir, 'frame.png'), fakePng(8, 8))
    mockVideoApi({ polls: [COMPLETED] })
    const r = await runTool({
      path: 'out/clip.mp4',
      prompt: 'the corgi starts running',
      first_frame: 'frame.png',
      duration: '8',
      generate_audio: 'false'
    })
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('out/clip.mp4')
    expect(r.summary).toContain('first frame')
    const written = await readFile(join(workspaceDir, 'out', 'clip.mp4'))
    expect(written.equals(MP4)).toBe(true)

    const body = calls[0].body!
    expect(body.duration).toBe(8)
    expect(body.generate_audio).toBe(false)
    const frames = body.frame_images as Array<{ image_url: { url: string }; frame_type: string }>
    expect(frames).toHaveLength(1)
    expect(frames[0].frame_type).toBe('first_frame')
    expect(frames[0].image_url.url.startsWith('data:image/png;base64,')).toBe(true)

    const data = r.data as Record<string, unknown>
    expect(data.costUsd).toBe(0.32)
    expect(data.firstFrame).toBe('frame.png')
    expect(data.jobId).toBe('job1')
    expect(JSON.stringify(r)).not.toContain('data:image')
  })

  test('passes reference images through as input_references', async () => {
    mockVideoApi({ polls: [COMPLETED] })
    const r = await runTool({ path: 'ref.mp4', prompt: 'p', reference_images: ['https://x.test/a.png'] })
    expect(r.ok).toBe(true)
    expect(calls[0].body!.input_references).toEqual([{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }])
    expect((r.data as Record<string, unknown>).referenceImages).toEqual(['https://x.test/a.png'])
  })

  test('a post-submit failure says it may have been billed and surfaces the job id', async () => {
    mockVideoApi({ polls: [{ json: { status: 'failed', error: 'moderation' } }] })
    const r = await runTool({ path: 'fail.mp4', prompt: 'p' })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('generation_failed')
    const data = r.data as Record<string, unknown>
    expect(data.mayHaveBeenBilled).toBe(true)
    expect(data.jobId).toBe('job1')
    expect(String(data.detail)).toContain('moderation')
  })

  test('a catalog lookup failure does not block generation', async () => {
    mockVideoApi({ polls: [COMPLETED] })
    const r = await runTool(
      { path: 'nocat.mp4', prompt: 'p', duration: 5 },
      {
        lookupModel: async () => {
          throw new Error('catalog down')
        }
      }
    )
    expect(r.ok).toBe(true)
  })
})

describe('generate_video approval preview', () => {
  test('lists cost knobs and uploads, masking inline data URLs', async () => {
    const { previewMutatingTool } = await import('../src/main/agent/orchestrator/approval-previews')
    const p = await previewMutatingTool('generate_video', {
      path: 'clip.mp4',
      prompt: 'p',
      duration: 8,
      resolution: '1080p',
      first_frame: 'data:image/png;base64,QUFBQUFB'
    })
    expect(p.title).toBe('Generate video \u2192 clip.mp4')
    const command = String((p.extra as { command?: string }).command)
    expect(command).toContain('duration: 8')
    expect(command).toContain('resolution: 1080p')
    expect(command).toContain('first frame (uploaded to the video provider): <inline data URL>')
    expect(command).not.toContain('QUFBQUFB')
  })
})
