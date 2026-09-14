// generate_image tool implementation — generates an image via OpenRouter's dedicated /images
// endpoint using a SEPARATE, user-configured image model (AppSettings.imageModel), independent of
// whatever chat model the tab is driving. The bytes are written to disk as a real file, sandboxed
// exactly like write_file, and additionally handed back as a data URL that orchestrator/loop.ts
// lifts off the payload into a `uiOnly` ImageBlock: the user sees a thumbnail of the image they
// paid for, but it is never uploaded to the model on subsequent turns (see ImageBlock.uiOnly).
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolResultPayload } from '@shared/types'
import { resolveWorkspacePath } from './file-ops'
import { assertMutationAllowed } from '../../workspace'
import { sniffDimensions } from './image'
import { generateImage, type GenerateImageResult } from '../../openrouter/images'

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

export interface GenerateImageToolArgs {
  path?: string
  prompt?: string
  /** Per-call override of the configured image model. */
  model?: string
  aspect_ratio?: string
  resolution?: string
  quality?: string
  background?: string
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
}

/** Extracts the lowercased final extension, or '' when the path has none. */
function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  if (!base.includes('.')) return ''
  return base.split('.').pop()?.toLowerCase() ?? ''
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

  opts.onProgress?.(`Generating image with ${opts.model} (this can take up to a minute or two)…`)

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
    summary: `Generated ${path} (${dims}${kb} KB, ${opts.model}${cost})${mismatch}`,
    data: {
      path,
      model: opts.model,
      prompt,
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
