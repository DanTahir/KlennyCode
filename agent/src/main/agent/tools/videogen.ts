// generate_video tool implementation — generates a short clip via OpenRouter's asynchronous
// /videos API using a SEPARATE, user-configured video model (AppSettings.videoModel), independent
// of the tab's chat model. The bytes are written to disk as a real file, sandboxed exactly like
// write_file.
//
// Two image-input modes, deliberately mutually exclusive here:
//  - `first_frame` / `last_frame` → OpenRouter `frame_images` (image-to-video: exact frames)
//  - `reference_images`           → OpenRouter `input_references` (reference-to-video: guidance)
// OpenRouter documents that when both are sent, frame_images wins and the references are
// ignored. Silently dropping inputs the user asked for and charging anyway is exactly what
// generate_image's references design forbids, so the combination is refused before spending.
//
// Unlike generate_image, nothing is handed back as a data URL: a video is megabytes to hundreds of
// megabytes, and the uiOnly ImageBlock path persists its payload in the session log.
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolResultPayload, VideoModelInfo } from '@shared/types'
import { resolveWorkspacePath } from './file-ops'
import { assertMutationAllowed } from '../../workspace'
import {
  normalizeReferenceImagesArg,
  resolveReferenceImage,
  MAX_REFERENCE_IMAGES,
  MAX_TOTAL_REFERENCE_BYTES
} from './imagegen'
import {
  generateVideo,
  fetchVideoModels,
  isAbortError,
  VideoGenerationError,
  type GenerateVideoOptions,
  type GenerateVideoResult,
  type VideoFrameImage,
  type VideoFrameType
} from '../../openrouter/videos'

/** OpenRouter's content endpoint delivers MP4. Other containers would just produce a file whose
 *  extension lies about its contents, so v1 accepts .mp4 only. */
export const SUPPORTED_VIDEO_OUTPUT_EXTENSIONS = '.mp4'
/** The catalog lookup is best-effort and must never hang a turn. */
const MODEL_LOOKUP_TIMEOUT_MS = 10_000

export interface GenerateVideoToolArgs {
  path?: string
  prompt?: string
  /** Per-call override of the configured video model. */
  model?: string
  /** The remaining fields are typed `unknown` because they are coerced tolerantly: tool schemas
   *  are documentation only, and models send `"8"` for 8 and `"true"` for true. */
  duration?: unknown
  resolution?: unknown
  aspect_ratio?: unknown
  size?: unknown
  generate_audio?: unknown
  seed?: unknown
  first_frame?: unknown
  last_frame?: unknown
  reference_images?: unknown
}

export interface GenerateVideoToolOptions {
  apiKey: string
  /** Already resolved by the caller: args.model ?? AppSettings.videoModel. */
  model: string
  /** Assistant-tab documentsDirectory, or undefined to use the open project workspace. */
  root?: string
  signal?: AbortSignal
  /** Surfaces live job status — a generation routinely takes minutes. */
  onProgress?: (message: string) => void
  /** Resolves the model's catalog record for the pre-spend parameter check. Injected by tests;
   *  defaults to the 5-minute-cached /videos/models catalog. */
  lookupModel?: (modelId: string) => Promise<VideoModelInfo | undefined>
  /** Test hooks forwarded to the client (poll schedule, clock, sleep, timeout). */
  client?: Pick<GenerateVideoOptions, 'pollScheduleMs' | 'timeoutMs' | 'sleep' | 'now'>
}

function fail(summary: string, error: string, data?: Record<string, unknown>): ToolResultPayload {
  return { ok: false, summary, error, ...(data ? { data } : {}) }
}

function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  if (!base.includes('.')) return ''
  return base.split('.').pop()?.toLowerCase() ?? ''
}

type Coerced<T> = { ok: true; value?: T } | { ok: false; detail: string }

function coerceOptionalString(raw: unknown, name: string): Coerced<string> {
  if (raw == null) return { ok: true }
  if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: String(raw) }
  if (typeof raw !== 'string') return { ok: false, detail: `\`${name}\` must be a string.` }
  const trimmed = raw.trim()
  return { ok: true, value: trimmed || undefined }
}

/** Accepts 8, "8" and "8s". */
function coerceOptionalInt(raw: unknown, name: string, opts: { positive?: boolean } = {}): Coerced<number> {
  if (raw == null || raw === '') return { ok: true }
  let n = Number.NaN
  if (typeof raw === 'number') n = raw
  else if (typeof raw === 'string' && /^\s*-?\d+\s*s?\s*$/i.test(raw)) n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || (opts.positive && n <= 0)) {
    return { ok: false, detail: `\`${name}\` must be ${opts.positive ? 'a positive' : 'an'} integer.` }
  }
  return { ok: true, value: n }
}

function coerceOptionalBool(raw: unknown, name: string): Coerced<boolean> {
  if (raw == null || raw === '') return { ok: true }
  if (typeof raw === 'boolean') return { ok: true, value: raw }
  if (typeof raw === 'string' && /^(true|false)$/i.test(raw.trim())) {
    return { ok: true, value: raw.trim().toLowerCase() === 'true' }
  }
  return { ok: false, detail: `\`${name}\` must be true or false.` }
}

export interface VideoParameterRequest {
  duration?: number
  resolution?: string
  aspectRatio?: string
  size?: string
  frameTypes: VideoFrameType[]
}

const sameCI = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Pre-spend check of the requested knobs against the model's live catalog record. Returns every
 * problem found (empty = proceed).
 *
 * Same permissive posture as generate_image's referenceSupportProblem: only a NON-EMPTY list that
 * excludes the requested value refuses. A null/empty list means the catalog is silent, not that
 * the knob is unsupported — verified live, heygen/avatar-iv animates a photo yet lists
 * `supported_frame_images: null`. Reference images have no catalog field at all, so they are
 * never refused here; the provider stays the final authority.
 */
export function videoParameterProblems(model: VideoModelInfo | undefined, req: VideoParameterRequest): string[] {
  if (!model) return []
  const problems: string[] = []
  const listed = <T>(list: T[] | null): list is T[] => Array.isArray(list) && list.length > 0

  if (req.duration != null && listed(model.supportedDurations) && !model.supportedDurations.includes(req.duration)) {
    const sorted = [...model.supportedDurations].sort((a, b) => a - b)
    problems.push(`duration ${req.duration}s is not supported (supported: ${sorted.join(', ')} seconds)`)
  }
  if (req.resolution && listed(model.supportedResolutions) && !model.supportedResolutions.some((r) => sameCI(r, req.resolution!))) {
    problems.push(`resolution '${req.resolution}' is not supported (supported: ${model.supportedResolutions.join(', ')})`)
  }
  if (req.aspectRatio && listed(model.supportedAspectRatios) && !model.supportedAspectRatios.includes(req.aspectRatio)) {
    problems.push(`aspect_ratio '${req.aspectRatio}' is not supported (supported: ${model.supportedAspectRatios.join(', ')})`)
  }
  if (req.size && listed(model.supportedSizes) && !model.supportedSizes.some((s) => sameCI(s, req.size!))) {
    problems.push(`size '${req.size}' is not supported (supported: ${model.supportedSizes.join(', ')})`)
  }
  if (listed(model.supportedFrameImages)) {
    for (const frameType of req.frameTypes) {
      if (!model.supportedFrameImages.includes(frameType)) {
        const arg = frameType === 'first_frame' ? 'first_frame' : 'last_frame'
        problems.push(
          `\`${arg}\` is not supported (this model only takes: ${model.supportedFrameImages.join(', ')})`
        )
      }
    }
  }
  return problems
}

async function lookupVideoModel(apiKey: string, modelId: string, signal?: AbortSignal): Promise<VideoModelInfo | undefined> {
  return (await fetchVideoModels(apiKey, false, signal)).find((m) => m.id === modelId)
}

/** Resolves to undefined if `p` hasn't settled within `ms`; rejections propagate. */
async function withSoftDeadline<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

export async function generateVideoTool(
  args: GenerateVideoToolArgs,
  opts: GenerateVideoToolOptions
): Promise<ToolResultPayload> {
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''

  if (!path) {
    return fail('generate_video requires a `path`', 'invalid_args', {
      detail: `Pass a destination path ending in ${SUPPORTED_VIDEO_OUTPUT_EXTENSIONS}`
    })
  }
  if (!prompt) {
    return fail('generate_video requires a `prompt`', 'invalid_args', {
      detail: 'Describe the video to generate in the `prompt` argument.'
    })
  }
  if (!opts.model) {
    return fail('No video model is configured', 'not_configured', {
      detail: 'Pick a video model in Settings \u2192 Models \u2192 Video generation, then retry.'
    })
  }
  if (extensionOf(path) !== 'mp4') {
    return fail(`Unsupported video output extension: ${path}`, 'unsupported_type', {
      detail: `generate_video writes ${SUPPORTED_VIDEO_OUTPUT_EXTENSIONS} files (the format OpenRouter delivers).`
    })
  }

  // Resolve and sandbox-check BEFORE any paid call, exactly like generate_image: discovering the
  // destination is unwritable after a multi-minute, per-second-billed generation is the worst case.
  let abs: string
  try {
    abs = resolveWorkspacePath(path, opts.root)
  } catch (e) {
    return fail(`Invalid path: ${path}`, 'invalid_path', { detail: e instanceof Error ? e.message : String(e) })
  }
  if (!assertMutationAllowed(abs, opts.root)) {
    return fail(`Refusing to write outside the allowed root: ${path}`, 'outside_workspace', {
      detail:
        'Generated videos must be written inside the open workspace (or, on Assistant tabs, the configured documents directory).'
    })
  }

  const duration = coerceOptionalInt(args.duration, 'duration', { positive: true })
  const seed = coerceOptionalInt(args.seed, 'seed')
  const generateAudio = coerceOptionalBool(args.generate_audio, 'generate_audio')
  const resolution = coerceOptionalString(args.resolution, 'resolution')
  const aspectRatio = coerceOptionalString(args.aspect_ratio, 'aspect_ratio')
  const size = coerceOptionalString(args.size, 'size')
  const firstFrame = coerceOptionalString(args.first_frame, 'first_frame')
  const lastFrame = coerceOptionalString(args.last_frame, 'last_frame')
  for (const c of [duration, seed, generateAudio, resolution, aspectRatio, size, firstFrame, lastFrame]) {
    if (!c.ok) return fail('Invalid generate_video argument', 'invalid_args', { detail: c.detail })
  }
  // Narrowed by the loop above; re-read as values for readability.
  const v = <T>(c: Coerced<T>): T | undefined => (c.ok ? c.value : undefined)

  const refArg = normalizeReferenceImagesArg(args.reference_images)
  if (!refArg.ok) return fail('Invalid `reference_images` argument', 'invalid_args', { detail: refArg.detail })
  const refs = refArg.refs

  const frameSpecs: Array<{ ref: string; frameType: VideoFrameType }> = []
  if (v(firstFrame)) frameSpecs.push({ ref: v(firstFrame)!, frameType: 'first_frame' })
  if (v(lastFrame)) frameSpecs.push({ ref: v(lastFrame)!, frameType: 'last_frame' })

  if (frameSpecs.length > 0 && refs.length > 0) {
    return fail('`first_frame`/`last_frame` cannot be combined with `reference_images`', 'invalid_args', {
      detail:
        'OpenRouter treats a request with frame images as image-to-video and silently ignores reference images, so the references would be dropped while you are still billed. Use frames (exact start/end image) OR reference_images (style/subject guidance), not both.'
    })
  }
  if (refs.length > MAX_REFERENCE_IMAGES) {
    return fail(`Too many reference images (${refs.length}, limit ${MAX_REFERENCE_IMAGES})`, 'invalid_args', {
      detail: 'Pass fewer reference images. Per-model limits are often lower still.'
    })
  }

  // Every image is read and validated BEFORE the paid call, with generate_image's exact rules
  // (local paths inlined as data URLs that exist only in the outgoing request; http(s) URLs passed
  // through; data: URLs and non-image files refused).
  let totalBytes = 0
  const frameImages: VideoFrameImage[] = []
  const inputReferences: string[] = []
  const pending = [
    ...frameSpecs.map((f) => ({ ref: f.ref, frameType: f.frameType as VideoFrameType | undefined })),
    ...refs.map((ref) => ({ ref, frameType: undefined as VideoFrameType | undefined }))
  ]
  for (const item of pending) {
    const resolved = await resolveReferenceImage(item.ref, opts.root)
    if (!resolved.ok) return resolved.payload
    totalBytes += resolved.bytes
    if (totalBytes > MAX_TOTAL_REFERENCE_BYTES) {
      return fail(`Input images too large in total (limit ${MAX_TOTAL_REFERENCE_BYTES / 1024 / 1024} MB)`, 'too_large', {
        detail: 'Pass fewer or smaller images.'
      })
    }
    if (item.frameType) frameImages.push({ url: resolved.url, frameType: item.frameType })
    else inputReferences.push(resolved.url)
  }

  const request: VideoParameterRequest = {
    duration: v(duration),
    resolution: v(resolution),
    aspectRatio: v(aspectRatio),
    size: v(size),
    frameTypes: frameSpecs.map((f) => f.frameType)
  }
  const needsCatalog =
    request.duration != null || request.resolution || request.aspectRatio || request.size || request.frameTypes.length > 0
  if (needsCatalog) {
    // Best-effort: a catalog failure, timeout or unknown id deliberately does NOT block.
    let info: VideoModelInfo | undefined
    try {
      const lookup = opts.lookupModel ?? ((id: string) => lookupVideoModel(opts.apiKey, id, opts.signal))
      info = await withSoftDeadline(lookup(opts.model), MODEL_LOOKUP_TIMEOUT_MS)
    } catch {
      info = undefined
    }
    const problems = videoParameterProblems(info, request)
    if (problems.length > 0) {
      return fail(`${opts.model} cannot fulfil this request: ${problems[0]}`, 'unsupported_parameters', {
        detail: problems.join('; '),
        model: opts.model
      })
    }
  }

  const inputs =
    frameImages.length > 0
      ? frameImages.map((f) => (f.frameType === 'first_frame' ? 'first frame' : 'last frame')).join(' + ')
      : inputReferences.length > 0
        ? `${inputReferences.length} reference image${inputReferences.length === 1 ? '' : 's'}`
        : ''
  opts.onProgress?.(
    `Submitting video job to ${opts.model}${inputs ? ` with ${inputs}` : ''} (generation usually takes 1\u201310 minutes)\u2026`
  )

  let generated: GenerateVideoResult
  try {
    generated = await generateVideo({
      apiKey: opts.apiKey,
      model: opts.model,
      prompt,
      duration: request.duration,
      resolution: request.resolution,
      aspectRatio: request.aspectRatio,
      size: request.size,
      generateAudio: v(generateAudio),
      seed: v(seed),
      frameImages,
      inputReferences,
      signal: opts.signal,
      onStatus: ({ jobId, status, elapsedMs }) =>
        opts.onProgress?.(
          `Video job ${jobId}: ${status.replace(/_/g, ' ')} \u2014 ${formatElapsed(elapsedMs)} elapsed (${opts.model})`
        ),
      ...opts.client
    })
  } catch (e) {
    if (isAbortError(e)) {
      return fail('Video generation was cancelled', 'aborted', {
        detail: 'If the job had already been submitted it may still finish upstream and be billed.',
        model: opts.model
      })
    }
    const submitted = e instanceof VideoGenerationError ? e.submitted : false
    const jobId = e instanceof VideoGenerationError ? e.jobId : undefined
    return fail(
      submitted
        ? `Video generation failed after job ${jobId ?? '(unknown id)'} was submitted, for ${path}`
        : `Video generation request failed for ${path}`,
      'generation_failed',
      {
        detail: e instanceof Error ? e.message : String(e),
        model: opts.model,
        ...(jobId ? { jobId } : {}),
        // Lets the model avoid a blind, doubly-billed retry.
        mayHaveBeenBilled: submitted
      }
    )
  }

  try {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, generated.buffer)
  } catch (e) {
    // The money is spent: say generation succeeded and only the write failed.
    return fail(`Generated the video but failed to write it to ${path}`, 'write_failed', {
      detail: e instanceof Error ? e.message : String(e),
      costUsd: generated.costUsd,
      jobId: generated.jobId
    })
  }

  const mb = generated.buffer.length / 1024 / 1024
  const sizeLabel = mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(generated.buffer.length / 1024))} KB`
  const cost = generated.costUsd > 0 ? `, $${generated.costUsd.toFixed(4)}` : ''
  const mismatch =
    generated.mimeType !== 'video/mp4'
      ? ` \u2014 note: the provider returned ${generated.mimeType} despite the .mp4 extension`
      : ''

  return {
    ok: true,
    summary: `Generated ${path} (${sizeLabel}, ${opts.model}${cost}${inputs ? `, ${inputs}` : ''})${mismatch}`,
    data: {
      path,
      model: opts.model,
      prompt,
      // Caller-supplied paths/URLs only — never the inlined data URLs, which would otherwise be
      // persisted to the session log and replayed to the model on every later turn.
      ...(v(firstFrame) ? { firstFrame: v(firstFrame) } : {}),
      ...(v(lastFrame) ? { lastFrame: v(lastFrame) } : {}),
      ...(refs.length > 0 ? { referenceImages: refs } : {}),
      ...(request.duration != null ? { duration: request.duration } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.size ? { size: request.size } : {}),
      mimeType: generated.mimeType,
      sizeBytes: generated.buffer.length,
      costUsd: generated.costUsd,
      jobId: generated.jobId,
      ...(generated.generationId ? { generationId: generated.generationId } : {})
    }
  }
}
