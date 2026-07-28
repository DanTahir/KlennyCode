// read_image tool implementation — reads an arbitrary image file from disk and returns it as a
// data URL, the same wire representation used for user-pasted/attached images (see ImageBlock in
// shared/types.ts and messages.ts's toORMessages). Global, read-only, follows the exact same
// path-resolution rules as read_file/read_docx (resolveWorkspacePath — absolute paths reach
// anywhere on the host; relative paths resolve against `root`/the open workspace).
import { readFile } from 'node:fs/promises'
import type { ToolResultPayload } from '@shared/types'
import { resolveWorkspacePath } from './file-ops'

// Generous but bounded — large images cost a lot of tokens once base64-encoded (~4/3x the byte
// size) and most vision models internally downscale well before this size anyway.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

// Deliberately limited to the formats vision models actually accept as an `image_url` data URL
// (Claude/GPT-family vision support png/jpeg/gif/webp) — anything else (bmp, svg, tiff, ...)
// would round-trip through the API but the model likely couldn't actually see it.
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

function mimeTypeForPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase()
  return ext ? MIME_BY_EXT[ext] : undefined
}

/** Best-effort width/height sniff from raw bytes — no image-parsing dependency needed for this.
 *  Returns undefined (rather than throwing) for any format/edge case not handled below; the
 *  dimensions are purely informational for the tool result summary, never required downstream. */
function sniffDimensions(buf: Buffer, mimeType: string): { width: number; height: number } | undefined {
  try {
    if (mimeType === 'image/png' && buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (mimeType === 'image/gif' && buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (mimeType === 'image/jpeg') {
      let offset = 2
      while (offset < buf.length - 9) {
        if (buf[offset] !== 0xff) {
          offset++
          continue
        }
        const marker = buf[offset + 1]
        // SOF0-SOF15 (excluding DHT/JPG/DAC markers) carry the frame dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
        }
        const segmentLength = buf.readUInt16BE(offset + 2)
        offset += 2 + segmentLength
      }
    }
    if (mimeType === 'image/webp' && buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const format = buf.toString('ascii', 12, 16)
      if (format === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      }
      if (format === 'VP8L') {
        const b = buf.readUInt32LE(21)
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
      }
    }
  } catch {
    // Malformed/truncated header — fall through to undefined below.
  }
  return undefined
}

/** Reads an image file from disk and returns it as a data URL, exactly like a user-pasted/
 *  attached image — the caller (orchestrator/loop.ts) lifts `data.dataUrl` off the payload and
 *  attaches it to the tool message as a real ImageBlock so the model actually sees it (a
 *  `tool`-role message's content can't itself carry an image_url part on OpenAI-compatible APIs
 *  — see messages.ts's doc comment), while keeping the persisted tool result payload itself free
 *  of the (often huge) base64 blob. */
export async function readImageTool(args: { path: string }, root?: string): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path, root)
  const mimeType = mimeTypeForPath(abs)
  if (!mimeType) {
    return {
      ok: false,
      summary: `Unrecognized image extension: ${args.path}`,
      error: 'unsupported_type',
      data: { detail: 'Supported extensions: .png, .jpg/.jpeg, .gif, .webp' }
    }
  }
  let buf: Buffer
  try {
    buf = await readFile(abs)
  } catch (e) {
    return { ok: false, summary: `File not found: ${args.path}`, error: 'not_found', data: { detail: e instanceof Error ? e.message : String(e) } }
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      summary: `Image too large: ${args.path} (${Math.round(buf.length / 1024 / 1024)} MB, limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB)`,
      error: 'too_large'
    }
  }
  const dimensions = sniffDimensions(buf, mimeType)
  const dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`
  const dims = dimensions ? `${dimensions.width}\u00d7${dimensions.height}, ` : ''
  return {
    ok: true,
    summary: `Read image ${args.path} (${dims}${Math.round(buf.length / 1024)} KB)`,
    data: { path: args.path, mimeType, sizeBytes: buf.length, ...dimensions, dataUrl }
  }
}
