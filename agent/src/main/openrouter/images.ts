import type { ImageModelInfo } from '@shared/types'
import { DEFAULT_IMAGE_MODEL } from '@shared/types'

const BASE = 'https://openrouter.ai/api/v1'

/**
 * Generous ceiling for a single generation. OpenRouter's own docs show ~94-second generations for
 * the higher-quality tiers, so anything much tighter would spuriously kill legitimate calls. The
 * point of having a deadline at all is that an *unbounded* await here could hang a whole turn
 * forever with no way out — the same failure mode as the browser tool's unbounded page.evaluate.
 */
export const IMAGE_GENERATION_TIMEOUT_MS = 180_000

export interface GenerateImageOptions {
  apiKey: string
  model: string
  prompt: string
  /**
   * Generation knobs. Every one of these is sent ONLY when explicitly set, because parameter
   * support varies per model and is not a superset: e.g. `openai/gpt-image-2.5-flare` supports
   * aspect_ratio/quality/background but NOT resolution or output_format, while
   * `bytedance-seed/seedream-5-0-*` does support resolution. Blindly sending every field would
   * risk a 400 from whichever model the user configured.
   */
  aspectRatio?: string
  resolution?: string
  quality?: string
  background?: string
  outputFormat?: 'png' | 'jpeg' | 'webp'
  signal?: AbortSignal
  timeoutMs?: number
}

export interface GenerateImageResult {
  buffer: Buffer
  /** From the response's `media_type`; may disagree with a requested outputFormat the model ignored. */
  mimeType: string
  costUsd: number
  promptTokens: number
  completionTokens: number
}

/**
 * Models observed to reject `output_format` outright rather than ignoring it. Process-lived and
 * keyed by model id, mirroring client.ts's reasoningRejectedModels: without it, the recovery retry
 * in generateImage() would fire on every single call for an incompatible model, permanently
 * doubling round trips on an endpoint where one request already takes tens of seconds.
 */
const outputFormatRejectedModels = new Set<string>()

interface ImagesApiResponse {
  created?: number
  data?: Array<{ b64_json?: string; media_type?: string }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    cost?: number
  }
}

/**
 * Calls OpenRouter's dedicated POST /images endpoint. This is a separate endpoint from
 * /chat/completions — it takes a `prompt` string rather than a `messages` array, and so never
 * passes through applyCacheControl. Prompt caching for the tab's chat model is therefore
 * structurally unaffected by generating an image.
 *
 * Mirrors createEmbeddings() in client.ts for headers and error style, and adds a bounded
 * deadline plus caller-abort linkage.
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const timeoutMs = opts.timeoutMs ?? IMAGE_GENERATION_TIMEOUT_MS

  // Link the caller's signal and our own deadline into one controller, and remember *why* we
  // aborted so a timeout reports as a timeout instead of a bare "This operation was aborted".
  const controller = new AbortController()
  const onOuterAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const body: Record<string, unknown> = { model: opts.model, prompt: opts.prompt }
  if (opts.aspectRatio) body.aspect_ratio = opts.aspectRatio
  if (opts.resolution) body.resolution = opts.resolution
  if (opts.quality) body.quality = opts.quality
  if (opts.background) body.background = opts.background
  // Skipped for models already known to reject this field (see outputFormatRejectedModels).
  if (opts.outputFormat && !outputFormatRejectedModels.has(opts.model)) {
    body.output_format = opts.outputFormat
  }

  const doPost = (payload: Record<string, unknown>): Promise<Response> =>
    fetch(`${BASE}/images`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/DanTahir/KlennyCode',
        'X-Title': 'Klenny Code'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

  try {
    let res = await doPost(body)

    // Recover-and-remember, same shape as client.ts's handling of providers that 400 on replayed
    // reasoning: parameter support here is per-model and not a superset, so a model that rejects
    // output_format rather than ignoring it gets exactly one retry without the field, and is then
    // remembered so later calls skip it up front.
    if (!res.ok && res.status === 400 && body.output_format != null) {
      const errText = await res.text().catch(() => '')
      if (/output_format/i.test(errText)) {
        outputFormatRejectedModels.add(opts.model)
        delete body.output_format
        res = await doPost(body)
      } else {
        throw new Error(`Image generation failed: 400${errText ? ` — ${errText}` : ''}`)
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Image generation failed: ${res.status}${errText ? ` — ${errText}` : ''}`)
    }

    const json = (await res.json()) as ImagesApiResponse
    const first = json.data?.[0]
    if (!first) {
      throw new Error('Image generation returned no image data (empty `data` array)')
    }
    const b64 = first.b64_json
    if (typeof b64 !== 'string' || b64.length === 0) {
      throw new Error('Image generation response contained no base64 image payload')
    }
    const buffer = Buffer.from(b64, 'base64')
    // Buffer.from silently drops invalid base64 characters rather than throwing, so a non-empty
    // input decoding to zero bytes is the only reliable signal that the payload was garbage.
    if (buffer.length === 0) {
      throw new Error('Image generation returned an undecodable base64 payload')
    }

    return {
      buffer,
      mimeType: first.media_type ?? 'image/png',
      costUsd: Number(json.usage?.cost ?? 0),
      promptTokens: Number(json.usage?.prompt_tokens ?? 0),
      completionTokens: Number(json.usage?.completion_tokens ?? 0)
    }
  } catch (err) {
    if (timedOut) {
      throw new Error(`Image generation timed out after ${Math.round(timeoutMs / 1000)}s`)
    }
    throw err
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
  }
}

let imageModelsCache: ImageModelInfo[] | null = null
let imageModelsCacheAt = 0

/**
 * Lists image-generation models via GET /images/models, with the same 5-minute in-process cache
 * as fetchModels().
 *
 * Deliberately NOT merged into fetchModels(): the image-models schema is not shape-compatible
 * with the chat one. `supported_parameters` here is an *object* of capability descriptors keyed by
 * request-field name (not the chat endpoint's string array), so fetchModels()' `.includes('tools')`
 * would explode on it; and pricing is not present on the model record at all (it lives only in the
 * per-endpoint records), so there is nothing to put in ModelInfo's per-token promptPrice.
 */
export async function fetchImageModels(
  apiKey: string,
  force = false,
  signal?: AbortSignal
): Promise<ImageModelInfo[]> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  if (!force && imageModelsCache && Date.now() - imageModelsCacheAt < 5 * 60_000) return imageModelsCache

  const res = await fetch(`${BASE}/images/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal
  })
  if (!res.ok) throw new Error(`Failed to fetch image models: ${res.status}`)
  const json = (await res.json()) as { data?: Array<Record<string, unknown>> }

  imageModelsCache = (json.data ?? []).map((m) => {
    const id = String(m.id)
    const arch = m.architecture as { input_modalities?: string[]; output_modalities?: string[] } | undefined
    const supported = (m.supported_parameters as Record<string, unknown>) ?? {}
    // Some models (e.g. the Recraft V4 Styles family) are image-to-image only: they require at
    // least one reference image, so they can never fulfil a pure text-to-image request. Surfacing
    // that lets the picker warn instead of letting the user select a guaranteed failure.
    const refs = supported.input_references as { min?: number } | undefined
    return {
      id,
      name: String(m.name ?? id),
      description: typeof m.description === 'string' ? m.description : undefined,
      inputModalities: arch?.input_modalities ?? [],
      outputModalities: arch?.output_modalities ?? [],
      supportedParameters: supported,
      supportsStreaming: m.supports_streaming === true,
      requiresInputReferences: typeof refs?.min === 'number' && refs.min >= 1,
      pinned: id === DEFAULT_IMAGE_MODEL
    } satisfies ImageModelInfo
  })

  imageModelsCache.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1
    if (!a.pinned && b.pinned) return 1
    return a.name.localeCompare(b.name)
  })

  imageModelsCacheAt = Date.now()
  return imageModelsCache
}
