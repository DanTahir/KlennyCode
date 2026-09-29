// generate_image tool implementation — generates an image via OpenRouter's dedicated /images
// endpoint using a SEPARATE, user-configured image model (AppSettings.imageModel), independent of
// whatever chat model the tab is driving. The bytes are written to disk as a real file, sandboxed
// exactly like write_file, and additionally handed back as a data URL that orchestrator/loop.ts
// lifts off the payload into a `uiOnly` ImageBlock: the user sees a thumbnail of the image they
// paid for, but it is never uploaded to the model on subsequent turns (see ImageBlock.uiOnly).
//
// Optional `reference_images` (local paths or http(s) URLs) enable image-to-image generation and
// editing via OpenRouter's `input_references`. Local references are read like read_image reads
// (they are reads, not mutations), inlined as data URLs that exist ONLY in the outgoing request,
// and never echoed into the tool result, which persists to the session log.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ImageModelInfo, ToolResultPayload } from '@shared/types'
import { resolveWorkspacePath } from './file-ops'
import { assertMutationAllowed } from '../../workspace'
import { sniffDimensions } from './image'
import { generateImage, fetchImageModels, type GenerateImageResult } from '../../openrouter/images'

/**
 * Destination extensions we accept, mapped to the `output_format` value OpenRouter documents.
 *
 * Deliberately NOT reusing read_image's MIME_BY_EXT: that map is about what vision models can
 * *read*, which is a different set from what this endpoint can *write*. Notably `.gif` is a valid
 * thing to read but is not a format OpenRouter can generate (documented output_format values are
 * png/jpeg/webp/svg), so accepting it here would produce a confusing provider-side failure after
 * the user had already been charged. `.svg` is left out of v1 because only the vector models emit
 * it and sniffDimensions can't measure it.
 */
const FORMAT_BY_EXT: Record<string, { mimeType: string; outputFormat: 'png' | 'jpeg' | 'webp' }> = {
  png: { mimeType: 'image/png', outputFormat: 'png' },
  jpg: { mimeType: 'image/jpeg', outputFormat: 'jpeg' },
  jpeg: { mimeType: 'image/jpeg', outputFormat: 'jpeg' },
  webp: { mimeType: 'image/webp', outputFormat: 'webp' }
}

export const SUPPORTED_OUTPUT_EXTENSIONS = '.png, .jpg/.jpeg, .webp'

/**
 * Accepted reference-image INPUT formats. Deliberately narrower than read_image's set: .gif is
 * readable by vision models, but OpenAI's image-edit input (the default model's family) takes
 * png/jpeg/webp only, so accepting it would fail provider-side with an unhelpful error.
 */
const REFERENCE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp'])
export const SUPPORTED_REFERENCE_EXTENSIONS = '.png, .jpg/.jpeg, .webp'

/** Same per-file cap as read_image. */
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024
/** Bounds the request body; base64 inflates ~4/3x, so this is ~27 MB of JSON on the wire. */
export const MAX_TOTAL_REFERENCE_BYTES = 20 * 1024 * 1024
/**
 * Hard ceiling regardless of model: the largest `input_references.max` in OpenRouter's live
 * catalog when this was written (openai/gpt-image-2.5-*: 16). Per-model limits are checked
 * separately against the live capability descriptor, see referenceSupportProblem().
 */
export const MAX_REFERENCE_IMAGES = 16
/** The catalog lookup is best-effort and must never hang a turn: fetchImageModels has no
 *  deadline of its own, only the caller's abort signal. */
const MODEL_LOOKUP_TIMEOUT_MS = 10_000

export interface GenerateImageToolArgs {
  path?: string
  prompt?: string
  /** Per-call override of the configured image model. */
  model?: string
  aspect_ratio?: string
  resolution?: string
  quality?: string
  background?: string
  /** File paths and/or http(s) URLs. Typed `unknown` because it is parsed tolerantly, see
   *  normalizeReferenceImagesArg(). */
  reference_images?: unknown
}

export interface GenerateImageToolOptions {
  apiKey: string
  /** Already resolved by the caller: args.model ?? AppSettings.imageModel. */
  model: string
  /** Assistant-tab documentsDirectory, or undefined to use the open project workspace. */
  root?: string
  signal?: AbortSignal
  /** Surfaces a "still generating" note — generations can legitimately take ~90 seconds, which
   *  otherwise looks like a hung turn. */
  onProgress?: (message: string) => void
  /** Resolves the model's capability record for the pre-spend reference check. Injected by tests;
   *  defaults to the 5-minute-cached /images/models catalog. Only consulted when references are
   *  given, so plain text-to-image calls make exactly the same single request as before. */
  lookupModel?: (modelId: string) => Promise<ImageModelInfo | undefined>
}

/** Extracts the lowercased final extension, or '' when the path has none. */
function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  if (!base.includes('.')) return ''
  return base.split('.').pop()?.toLowerCase() ?? ''
}

/**
 * Normalizes the `reference_images` argument. Tool schemas are documentation only, so this
 * tolerates the shapes models actually send: an array of strings, a single bare string, or a
 * JSON-stringified array. Exported so the approval preview lists exactly what will be sent.
 * Error details never echo the raw value, which could be an arbitrarily large blob.
 */
export function normalizeReferenceImagesArg(
  raw: unknown
): { ok: true; refs: string[] } | { ok: false; detail: string } {
  if (raw == null) return { ok: true, refs: [] }
  let list: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return { ok: true, refs: [] }
    if (trimmed.startsWith('[')) {
      try {
        list = JSON.parse(trimmed)
      } catch {
        return { ok: false, detail: '`reference_images` looked like a JSON array but did not parse.' }
      }
    } else {
      list = [trimmed]
    }
  }
  if (!Array.isArray(list)) {
    return { ok: false, detail: '`reference_images` must be an array of file paths or http(s) URLs.' }
  }
  const refs: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string' || !entry.trim()) {
      return {
        ok: false,
        detail: 'Every `reference_images` entry must be a non-empty string: a file path or an http(s) URL.'
      }
    }
    refs.push(entry.trim())
  }
  return { ok: true, refs }
}

/** Identifies png/jpeg/webp by signature, so a mislabeled file (JPEG bytes named .png) is sent
 *  with its real MIME type rather than one the provider may reject, and a non-image file with an
 *  image extension is refused before any money is spent. */
function sniffReferenceMime(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

type ReferenceResolution = { ok: true; url: string; bytes: number } | { ok: false; payload: ToolResultPayload }

function referenceFailure(summary: string, error: string, reference: string, detail: string): ReferenceResolution {
  return { ok: false, payload: { ok: false, summary, error, data: { reference, detail } } }
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Turns one reference entry into the URL sent upstream. http(s) URLs pass through untouched (the
 * provider fetches them). Anything else is a local file, resolved with read_image's exact rules
 * (resolveWorkspacePath: absolute paths reach anywhere readable, relative ones resolve against
 * `root`), because sending a reference is a READ of that file, not a mutation. The file is
 * inlined as a data URL that lives only in the outgoing request.
 */
async function resolveReference(ref: string, root: string | undefined): Promise<ReferenceResolution> {
  if (/^https?:\/\//i.test(ref)) return { ok: true, url: ref, bytes: 0 }
  if (/^data:/i.test(ref)) {
    return referenceFailure(
      'Inline data URLs are not accepted as reference images',
      'invalid_args',
      '<inline data URL>',
      'Save the image to a file and pass its path instead. Authoring base64 into tool arguments burns output tokens and bloats the conversation log.'
    )
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
    return referenceFailure(
      `Unsupported reference image URL scheme: ${ref}`,
      'invalid_args',
      ref,
      'Reference images must be local file paths or http(s) URLs.'
    )
  }
  if (!REFERENCE_EXTENSIONS.has(extensionOf(ref))) {
    return referenceFailure(
      `Unsupported reference image type: ${ref}`,
      'unsupported_type',
      ref,
      `Reference images must be ${SUPPORTED_REFERENCE_EXTENSIONS} files, or http(s) URLs.`
    )
  }
  let abs: string
  try {
    abs = resolveWorkspacePath(ref, root)
  } catch (e) {
    return referenceFailure(`Invalid reference image path: ${ref}`, 'invalid_path', ref, errMessage(e))
  }
  let buf: Buffer
  try {
    buf = await readFile(abs)
  } catch (e) {
    return referenceFailure(`Reference image not found: ${ref}`, 'not_found', ref, errMessage(e))
  }
  if (buf.length > MAX_REFERENCE_IMAGE_BYTES) {
    const mb = (buf.length / 1024 / 1024).toFixed(1)
    return referenceFailure(
      `Reference image too large: ${ref} (${mb} MB, limit ${MAX_REFERENCE_IMAGE_BYTES / 1024 / 1024} MB)`,
      'too_large',
      ref,
      'Downscale or re-encode the reference image and retry.'
    )
  }
  const mimeType = sniffReferenceMime(buf)
  if (!mimeType) {
    return referenceFailure(
      `Not a valid PNG/JPEG/WebP image: ${ref}`,
      'unsupported_type',
      ref,
      'The file extension looks right, but its contents are not a PNG, JPEG or WebP image.'
    )
  }
  return { ok: true, url: `data:${mimeType};base64,${buf.toString('base64')}`, bytes: buf.length }
}

/**
 * Pre-spend check of a reference count against the model's live capability record. Returns a
 * reason to refuse, or null to proceed.
 *
 * Deliberately permissive when the catalog is silent. Verified live: meta/muse-image advertises
 * reference-image editing and lists `image` in its input modalities, yet its model-level
 * `supported_parameters` is EMPTY, so reading a missing `input_references` descriptor as
 * "unsupported" would wrongly block it. Only an explicit signal refuses: a text-only input
 * modality list (e.g. recraft/recraft-v4.1-flash), or a `{ type: 'range', min, max }` descriptor
 * whose range excludes the requested count (e.g. inclusionai/ming-image-0.1-design has max 0).
 */
export function referenceSupportProblem(model: ImageModelInfo | undefined, count: number): string | null {
  if (!model || count === 0) return null
  if (model.inputModalities.length > 0 && !model.inputModalities.includes('image')) {
    return `${model.id} is text-to-image only and cannot take reference images.`
  }
  const descriptor = model.supportedParameters.input_references
  if (descriptor && typeof descriptor === 'object') {
    const { min, max } = descriptor as { min?: unknown; max?: unknown }
    if (typeof max === 'number' && count > max) {
      return max === 0
        ? `${model.id} does not accept reference images.`
        : `${model.id} accepts at most ${max} reference image${max === 1 ? '' : 's'}; ${count} were given.`
    }
    if (typeof min === 'number' && count < min) {
      return `${model.id} requires at least ${min} reference images; ${count} ${count === 1 ? 'was' : 'were'} given.`
    }
  }
  return null
}

async function lookupImageModel(
  apiKey: string,
  modelId: string,
  signal?: AbortSignal
): Promise<ImageModelInfo | undefined> {
  return (await fetchImageModels(apiKey, false, signal)).find((m) => m.id === modelId)
}

/** Resolves to undefined if `p` hasn't settled within `ms`; rejections propagate. */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
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

export async function generateImageTool(
  args: GenerateImageToolArgs,
  opts: GenerateImageToolOptions
): Promise<ToolResultPayload> {
  const path = typeof args.path === 'string' ? args.path.trim() : ''
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''

  if (!path) {
    return {
      ok: false,
      summary: 'generate_image requires a `path`',
      error: 'invalid_args',
      data: { detail: `Pass a destination path ending in one of: ${SUPPORTED_OUTPUT_EXTENSIONS}` }
    }
  }
  if (!prompt) {
    return {
      ok: false,
      summary: 'generate_image requires a `prompt`',
      error: 'invalid_args',
      data: { detail: 'Describe the image to generate in the `prompt` argument.' }
    }
  }
  if (!opts.model) {
    return {
      ok: false,
      summary: 'No image model is configured',
      error: 'not_configured',
      data: { detail: 'Pick an image model in Settings → Models → Image generation, then retry.' }
    }
  }

  const ext = extensionOf(path)
  const format = FORMAT_BY_EXT[ext]
  if (!format) {
    return {
      ok: false,
      summary: `Unsupported image output extension: ${path}`,
      error: 'unsupported_type',
      data: {
        detail: `generate_image can write ${SUPPORTED_OUTPUT_EXTENSIONS}. (.gif is readable by read_image but is not a format OpenRouter can generate.)`
      }
    }
  }

  // Resolve and sandbox-check BEFORE calling the API. Generation costs real money, so discovering
  // that the destination is outside the allowed root afterwards would mean the user is charged for
  // an image that then can't be saved anywhere.
  let abs: string
  try {
    abs = resolveWorkspacePath(path, opts.root)
  } catch (e) {
    return {
      ok: false,
      summary: `Invalid path: ${path}`,
      error: 'invalid_path',
      data: { detail: e instanceof Error ? e.message : String(e) }
    }
  }
  if (!assertMutationAllowed(abs, opts.root)) {
    return {
      ok: false,
      summary: `Refusing to write outside the allowed root: ${path}`,
      error: 'outside_workspace',
      data: { detail: 'Generated images must be written inside the open workspace (or, on Assistant tabs, the configured documents directory).' }
    }
  }

  const refArg = normalizeReferenceImagesArg(args.reference_images)
  if (!refArg.ok) {
    return {
      ok: false,
      summary: 'Invalid `reference_images` argument',
      error: 'invalid_args',
      data: { detail: refArg.detail }
    }
  }
  const refs = refArg.refs
  if (refs.length > MAX_REFERENCE_IMAGES) {
    return {
      ok: false,
      summary: `Too many reference images (${refs.length}, limit ${MAX_REFERENCE_IMAGES})`,
      error: 'invalid_args',
      data: { detail: 'Pass fewer reference images. Per-model limits are often lower still.' }
    }
  }

  // Every reference is read and validated BEFORE the paid call, for the same reason as the
  // destination check above: a missing, oversized or non-image reference must fail for free.
  const inputReferences: string[] = []
  let totalReferenceBytes = 0
  for (const ref of refs) {
    const resolved = await resolveReference(ref, opts.root)
    if (!resolved.ok) return resolved.payload
    totalReferenceBytes += resolved.bytes
    if (totalReferenceBytes > MAX_TOTAL_REFERENCE_BYTES) {
      return {
        ok: false,
        summary: `Reference images too large in total (limit ${MAX_TOTAL_REFERENCE_BYTES / 1024 / 1024} MB)`,
        error: 'too_large',
        data: { detail: 'Pass fewer or smaller reference images.' }
      }
    }
    inputReferences.push(resolved.url)
  }

  if (refs.length > 0) {
    // Best-effort pre-spend capability check. A catalog failure, timeout or unknown model id
    // deliberately does NOT block: the provider stays the final authority on what it accepts.
    let info: ImageModelInfo | undefined
    try {
      const lookup = opts.lookupModel ?? ((id: string) => lookupImageModel(opts.apiKey, id, opts.signal))
      info = await withDeadline(lookup(opts.model), MODEL_LOOKUP_TIMEOUT_MS)
    } catch {
      info = undefined
    }
    const problem = referenceSupportProblem(info, refs.length)
    if (problem) {
      return {
        ok: false,
        summary: `${opts.model} cannot take ${refs.length} reference image${refs.length === 1 ? '' : 's'}`,
        error: 'unsupported_references',
        data: { detail: problem, model: opts.model }
      }
    }
  }

  const refCount = refs.length > 0 ? `${refs.length} reference image${refs.length === 1 ? '' : 's'}` : ''
  opts.onProgress?.(
    `Generating image with ${opts.model}${refCount ? ` from ${refCount}` : ''} (this can take up to a minute or two)…`
  )

  let generated: GenerateImageResult
  try {
    generated = await generateImage({
      apiKey: opts.apiKey,
      model: opts.model,
      prompt,
      // Passed through only when actually set — parameter support varies per model.
      aspectRatio: args.aspect_ratio,
      resolution: args.resolution,
      quality: args.quality,
      background: args.background,
      outputFormat: format.outputFormat,
      inputReferences,
      signal: opts.signal
    })
  } catch (e) {
    return {
      ok: false,
      summary: `Image generation failed for ${path}`,
      error: 'generation_failed',
      data: { detail: e instanceof Error ? e.message : String(e), model: opts.model }
    }
  }

  try {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, generated.buffer)
  } catch (e) {
    // The money is already spent at this point, so be explicit that generation succeeded and only
    // the write failed — otherwise this reads like nothing happened and invites a costly retry.
    return {
      ok: false,
      summary: `Generated the image but failed to write it to ${path}`,
      error: 'write_failed',
      data: { detail: e instanceof Error ? e.message : String(e), costUsd: generated.costUsd }
    }
  }

  const dimensions = sniffDimensions(generated.buffer, generated.mimeType)
  const dataUrl = `data:${generated.mimeType};base64,${generated.buffer.toString('base64')}`
  const dims = dimensions ? `${dimensions.width}\u00d7${dimensions.height}, ` : ''
  const kb = Math.max(1, Math.round(generated.buffer.length / 1024))
  const cost = generated.costUsd > 0 ? `, $${generated.costUsd.toFixed(4)}` : ''
  // A model may ignore output_format and return a different encoding than the extension implies.
  // Say so rather than silently leaving e.g. JPEG bytes in a .png file.
  const mismatch =
    generated.mimeType !== format.mimeType
      ? ` — note: the model returned ${generated.mimeType} despite the .${ext} extension`
      : ''

  return {
    ok: true,
    summary: `Generated ${path} (${dims}${kb} KB, ${opts.model}${cost}${refCount ? `, ${refCount}` : ''})${mismatch}`,
    data: {
      path,
      model: opts.model,
      prompt,
      // The caller-supplied paths/URLs only. Never the inlined data URLs, which would otherwise be
      // persisted to the session log and replayed to the model on every later turn.
      ...(refs.length > 0 ? { referenceImages: refs } : {}),
      mimeType: generated.mimeType,
      sizeBytes: generated.buffer.length,
      ...dimensions,
      costUsd: generated.costUsd,
      promptTokens: generated.promptTokens,
      completionTokens: generated.completionTokens,
      // Both keys below are consumed and deleted by orchestrator/loop.ts before the payload is
      // persisted, so the base64 never reaches the session file or the compaction transcript.
      dataUrl,
      imageUiOnly: true
    }
  }
}
