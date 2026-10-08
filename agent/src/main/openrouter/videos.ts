// OpenRouter video generation client: POST /videos (submit) → GET /videos/{id} (poll) →
// GET /videos/{id}/content (download), plus the GET /videos/models catalog.
//
// Unlike /images this API is asynchronous — a submit returns 202 with a job id immediately, and
// a generation then takes anywhere from ~30 seconds to many minutes. Like /images it never touches
// /chat/completions, so it cannot affect prompt caching for the tab's chat model.
import type { VideoModelInfo } from '@shared/types'
import { DEFAULT_VIDEO_MODEL } from '@shared/types'
import { sanitizeProviderErrorText } from './images'

const BASE = 'https://openrouter.ai/api/v1'
/** The only origin the API key is ever sent to. See isTrustedUrl(). */
const TRUSTED_ORIGIN = 'https://openrouter.ai'

/** Bounds the submit round trip only; the job itself runs asynchronously upstream. Generous
 *  because the request body may carry several multi-megabyte inlined images. */
export const VIDEO_SUBMIT_TIMEOUT_MS = 60_000
/** Bounds each individual status poll. */
export const VIDEO_POLL_REQUEST_TIMEOUT_MS = 30_000
/** Overall ceiling from submit to completion. Higher-tier models legitimately take several
 *  minutes; without a ceiling a stuck job would hold the turn forever. */
export const VIDEO_GENERATION_TIMEOUT_MS = 20 * 60_000
/** Bounds the content download (headers AND body). */
export const VIDEO_DOWNLOAD_TIMEOUT_MS = 5 * 60_000
/** The download is buffered in memory before being written, so refuse anything absurd. */
export const MAX_VIDEO_BYTES = 1024 * 1024 * 1024
/** Wait before each poll; the last entry repeats. Front-loaded so fast models finish promptly,
 *  then backed off so a 10-minute job isn't polled 120 times. */
export const DEFAULT_POLL_SCHEDULE_MS = [5_000, 5_000, 10_000, 10_000, 15_000]
/** Transient poll failures (network blips, 429, 5xx) are tolerated up to this many in a row. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 5

const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'canceled', 'expired'])

export type VideoFrameType = 'first_frame' | 'last_frame'

export interface VideoFrameImage {
  /** http(s) URL or base64 data URL. */
  url: string
  frameType: VideoFrameType
}

export interface VideoStatusUpdate {
  jobId: string
  status: string
  elapsedMs: number
}

export interface GenerateVideoOptions {
  apiKey: string
  model: string
  prompt: string
  /** Every optional knob is sent ONLY when explicitly set: support varies per model, and an
   *  unsupported value is a 400 from the provider. */
  duration?: number
  resolution?: string
  aspectRatio?: string
  size?: string
  generateAudio?: boolean
  seed?: number
  /** Image-to-video: exact first and/or last frame. Sent as `frame_images`. */
  frameImages?: VideoFrameImage[]
  /** Reference-to-video: style/content guidance. Sent as `input_references`. */
  inputReferences?: string[]
  signal?: AbortSignal
  onStatus?: (update: VideoStatusUpdate) => void
  /** Test hooks. */
  pollScheduleMs?: number[]
  timeoutMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

export interface GenerateVideoResult {
  buffer: Buffer
  mimeType: string
  costUsd: number
  jobId: string
  generationId?: string
}

/**
 * A failure the tool layer must describe carefully. `submitted` is the important bit: once a job
 * has been accepted upstream the user may be billed for it even though no file ever arrives, so
 * the tool result has to say so rather than read like nothing happened (which invites a costly
 * blind retry).
 */
export class VideoGenerationError extends Error {
  readonly jobId?: string
  readonly submitted: boolean
  constructor(message: string, opts: { jobId?: string; submitted: boolean }) {
    super(message)
    this.name = 'VideoGenerationError'
    this.jobId = opts.jobId
    this.submitted = opts.submitted
  }
}

interface SubmitResponse {
  id?: string
  polling_url?: string
  status?: string
}

interface PollResponse {
  id?: string
  generation_id?: string
  status?: string
  unsigned_urls?: unknown
  usage?: { cost?: number }
  error?: unknown
}

class PollHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error ? e.name === 'AbortError' : e instanceof DOMException && e.name === 'AbortError'
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'HTTP-Referer': 'https://github.com/DanTahir/KlennyCode',
    'X-Title': 'Klenny Code'
  }
}

/**
 * The submit and poll responses hand back absolute URLs (`polling_url`, `unsigned_urls`) that we
 * must call WITH the API key, since the content URLs are not presigned. Following an arbitrary
 * server-supplied URL with a bearer token attached would leak the key to whatever host a
 * compromised or misbehaving response named, so only https://openrouter.ai URLs are followed; any
 * other value falls back to the documented URL built from the job id.
 */
export function isTrustedUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    return new URL(raw).origin === TRUSTED_ORIGIN
  } catch {
    return false
  }
}

/** Runs `fn` under a deadline linked to the caller's signal, reporting a timeout as a timeout
 *  rather than a bare "This operation was aborted". The controller stays live until `fn` settles,
 *  so a body read inside `fn` is covered too. */
async function withDeadline<T>(
  ms: number,
  outer: AbortSignal | undefined,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  if (outer?.aborted) throw abortError()
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  outer?.addEventListener('abort', onOuterAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, ms)
  try {
    return await fn(controller.signal)
  } catch (e) {
    if (timedOut) throw new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)
    throw e
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onOuterAbort)
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function describeJobError(err: unknown): string {
  if (typeof err === 'string' && err) return sanitizeProviderErrorText(err)
  if (err && typeof err === 'object') {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string' && message) return sanitizeProviderErrorText(message)
    try {
      return sanitizeProviderErrorText(JSON.stringify(err))
    } catch {
      // fall through
    }
  }
  return 'no error detail was returned'
}

/** Identifies the container by signature: ISO-BMFF (`ftyp` at offset 4, `qt  ` brand =
 *  QuickTime) or EBML (WebM/Matroska). undefined when unrecognized. */
export function sniffVideoMime(buf: Buffer): string | undefined {
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    return buf.toString('ascii', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4'
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm'
  return undefined
}

function buildBody(opts: GenerateVideoOptions): Record<string, unknown> {
  const body: Record<string, unknown> = { model: opts.model, prompt: opts.prompt }
  if (typeof opts.duration === 'number') body.duration = opts.duration
  if (opts.resolution) body.resolution = opts.resolution
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio
  if (opts.size) body.size = opts.size
  if (typeof opts.generateAudio === 'boolean') body.generate_audio = opts.generateAudio
  if (typeof opts.seed === 'number') body.seed = opts.seed
  if (opts.frameImages && opts.frameImages.length > 0) {
    body.frame_images = opts.frameImages.map((f) => ({
      type: 'image_url',
      image_url: { url: f.url },
      frame_type: f.frameType
    }))
  }
  if (opts.inputReferences && opts.inputReferences.length > 0) {
    body.input_references = opts.inputReferences.map((url) => ({ type: 'image_url', image_url: { url } }))
  }
  return body
}

/**
 * Submits a video job, polls it to completion and downloads the result into memory.
 *
 * Throws a VideoGenerationError for every non-abort failure (with `submitted` telling the caller
 * whether money may already be committed), and lets an AbortError from the caller's signal
 * propagate untouched.
 */
export async function generateVideo(opts: GenerateVideoOptions): Promise<GenerateVideoResult> {
  if (opts.signal?.aborted) throw abortError()
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? Date.now
  const schedule = opts.pollScheduleMs && opts.pollScheduleMs.length > 0 ? opts.pollScheduleMs : DEFAULT_POLL_SCHEDULE_MS
  const timeoutMs = opts.timeoutMs ?? VIDEO_GENERATION_TIMEOUT_MS

  // 1. Submit.
  let submitted: SubmitResponse
  try {
    submitted = await withDeadline(VIDEO_SUBMIT_TIMEOUT_MS, opts.signal, 'Video generation request', async (signal) => {
      const res = await fetch(`${BASE}/videos`, {
        method: 'POST',
        headers: { ...headers(opts.apiKey), 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(opts)),
        signal
      })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new VideoGenerationError(
          `Video generation request failed: ${res.status}${errText ? ` \u2014 ${sanitizeProviderErrorText(errText)}` : ''}`,
          { submitted: false }
        )
      }
      return (await res.json()) as SubmitResponse
    })
  } catch (e) {
    if (e instanceof VideoGenerationError) throw e
    if (isAbortError(e) && opts.signal?.aborted) throw e
    throw new VideoGenerationError(`Video generation request failed: ${errMessage(e)}`, { submitted: false })
  }

  const jobId = typeof submitted.id === 'string' ? submitted.id : ''
  if (!jobId) {
    // A 2xx without an id: the provider may still have accepted it, so err on the side of telling
    // the user they could be billed.
    throw new VideoGenerationError('Video generation response contained no job id', { submitted: true })
  }

  // 2. Poll until a terminal status.
  const pollUrl = isTrustedUrl(submitted.polling_url)
    ? submitted.polling_url
    : `${BASE}/videos/${encodeURIComponent(jobId)}`
  const start = now()
  let status = typeof submitted.status === 'string' ? submitted.status : 'pending'
  opts.onStatus?.({ jobId, status, elapsedMs: 0 })

  let completed: PollResponse | undefined
  let consecutiveFailures = 0
  for (let attempt = 0; !completed; attempt++) {
    const elapsed = now() - start
    if (elapsed >= timeoutMs) {
      throw new VideoGenerationError(
        `Video job ${jobId} did not finish within ${Math.round(timeoutMs / 60_000)} minutes (last status: ${status})`,
        { jobId, submitted: true }
      )
    }
    await sleep(Math.min(schedule[Math.min(attempt, schedule.length - 1)], timeoutMs - elapsed), opts.signal)

    let poll: PollResponse
    try {
      poll = await withDeadline(VIDEO_POLL_REQUEST_TIMEOUT_MS, opts.signal, 'Video status poll', async (signal) => {
        const res = await fetch(pollUrl, { headers: headers(opts.apiKey), signal })
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          throw new PollHttpError(
            `status poll failed: ${res.status}${errText ? ` \u2014 ${sanitizeProviderErrorText(errText)}` : ''}`,
            res.status
          )
        }
        return (await res.json()) as PollResponse
      })
    } catch (e) {
      if (isAbortError(e) && opts.signal?.aborted) throw e
      // Auth/not-found won't fix themselves; everything else (network, 429, 5xx, a slow poll) is
      // retried, since giving up on a job that is still running wastes money already committed.
      if (e instanceof PollHttpError && (e.status === 401 || e.status === 403 || e.status === 404)) {
        throw new VideoGenerationError(`Video job ${jobId}: ${e.message}`, { jobId, submitted: true })
      }
      consecutiveFailures++
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new VideoGenerationError(
          `Lost track of video job ${jobId}: ${consecutiveFailures} consecutive status polls failed (last: ${errMessage(e)})`,
          { jobId, submitted: true }
        )
      }
      continue
    }

    consecutiveFailures = 0
    if (typeof poll.status === 'string') status = poll.status
    opts.onStatus?.({ jobId, status, elapsedMs: now() - start })
    if (status === 'completed') {
      completed = poll
    } else if (TERMINAL_FAILURE_STATUSES.has(status)) {
      throw new VideoGenerationError(`Video generation ${status}: ${describeJobError(poll.error)}`, {
        jobId,
        submitted: true
      })
    }
  }

  // 3. Download.
  const urls = Array.isArray(completed.unsigned_urls) ? completed.unsigned_urls : []
  const contentUrl = isTrustedUrl(urls[0]) ? urls[0] : `${BASE}/videos/${encodeURIComponent(jobId)}/content?index=0`
  let downloaded: { buffer: Buffer; mimeType: string }
  try {
    downloaded = await withDeadline(VIDEO_DOWNLOAD_TIMEOUT_MS, opts.signal, 'Video download', async (signal) => {
      const res = await fetch(contentUrl, { headers: headers(opts.apiKey), signal })
      if (!res.ok) {
        const errText = await res.text().catch(() => '')
        throw new Error(`${res.status}${errText ? ` \u2014 ${sanitizeProviderErrorText(errText)}` : ''}`)
      }
      const declared = Number(res.headers?.get?.('content-length') ?? Number.NaN)
      if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) {
        throw new Error(`video is ${Math.round(declared / 1024 / 1024)} MB, over the ${MAX_VIDEO_BYTES / 1024 / 1024} MB limit`)
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length === 0) throw new Error('the content endpoint returned an empty body')
      if (buffer.length > MAX_VIDEO_BYTES) {
        throw new Error(`video is over the ${MAX_VIDEO_BYTES / 1024 / 1024} MB limit`)
      }
      const header = res.headers?.get?.('content-type')?.split(';')[0]?.trim().toLowerCase()
      const mimeType = sniffVideoMime(buffer) ?? (header && header.startsWith('video/') ? header : 'application/octet-stream')
      return { buffer, mimeType }
    })
  } catch (e) {
    if (isAbortError(e) && opts.signal?.aborted) throw e
    throw new VideoGenerationError(`Video job ${jobId} completed but downloading it failed: ${errMessage(e)}`, {
      jobId,
      submitted: true
    })
  }

  const cost = Number(completed.usage?.cost ?? 0)
  return {
    buffer: downloaded.buffer,
    mimeType: downloaded.mimeType,
    costUsd: Number.isFinite(cost) ? cost : 0,
    jobId,
    ...(typeof completed.generation_id === 'string' ? { generationId: completed.generation_id } : {})
  }
}

let videoModelsCache: VideoModelInfo[] | null = null
let videoModelsCacheAt = 0

const stringList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
const numberList = (v: unknown): number[] | null =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : null
const nullableBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

/** Lists video-generation models via GET /videos/models, with the same 5-minute in-process cache
 *  as fetchModels()/fetchImageModels(). */
export async function fetchVideoModels(apiKey: string, force = false, signal?: AbortSignal): Promise<VideoModelInfo[]> {
  if (signal?.aborted) throw abortError()
  if (!force && videoModelsCache && Date.now() - videoModelsCacheAt < 5 * 60_000) return videoModelsCache

  const res = await fetch(`${BASE}/videos/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal })
  if (!res.ok) throw new Error(`Failed to fetch video models: ${res.status}`)
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> }

  const models = (json.data ?? []).map((m) => {
    const id = String(m.id)
    const supportedDurations = numberList(m.supported_durations)
    const supportedFrameImages = stringList(m.supported_frame_images)
    const pricing: Record<string, string> = {}
    if (m.pricing_skus && typeof m.pricing_skus === 'object') {
      for (const [k, v] of Object.entries(m.pricing_skus as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') pricing[k] = String(v)
      }
    }
    return {
      id,
      name: String(m.name ?? id),
      description: typeof m.description === 'string' ? m.description : undefined,
      supportedDurations,
      supportedResolutions: stringList(m.supported_resolutions),
      supportedAspectRatios: stringList(m.supported_aspect_ratios),
      supportedSizes: stringList(m.supported_sizes),
      supportedFrameImages,
      generateAudio: nullableBool(m.generate_audio),
      seed: nullableBool(m.seed),
      pricingSkus: pricing,
      allowedPassthroughParameters: stringList(m.allowed_passthrough_parameters) ?? [],
      requiresSourceMedia: !supportedDurations?.length && !supportedFrameImages?.length,
      pinned: id === DEFAULT_VIDEO_MODEL
    } satisfies VideoModelInfo
  })

  models.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return a.name.localeCompare(b.name)
  })

  videoModelsCache = models
  videoModelsCacheAt = Date.now()
  return models
}
