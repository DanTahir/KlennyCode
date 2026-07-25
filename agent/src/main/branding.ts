/**
 * Custom appearance/branding assets — an optional custom app icon (sidebar, window/taskbar icon,
 * tray) and a custom "AI is working" animation (shown in place of the default klenny.gif while
 * the agent is streaming an empty assistant turn). Mirrors the settings.ts pattern used for
 * secrets: only a boolean flag (`hasCustomIcon` / `hasCustomRunningGif`) lives in settings.json,
 * while the actual bytes live as plain files under the app's userData directory so they never
 * bloat settings.json or round-trip through JSON as base64.
 */
import { app, nativeImage, type NativeImage } from 'electron'
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

function brandingDir(): string {
  return join(app.getPath('userData'), 'branding')
}

// Electron's nativeImage only reliably supports PNG/JPEG (and ICO on Windows) — restrict
// uploads to those so the icon also works as the window/taskbar/tray icon, not just in the
// renderer's <img> tags.
const ICON_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg'
}
const ICON_EXTS = Object.values(ICON_MIME_TO_EXT)

// The "AI is working" animation is only ever rendered in an <img> tag in the renderer, so any
// animated format Chromium supports is fine.
const GIF_MIME_TO_EXT: Record<string, string> = {
  'image/gif': 'gif',
  'image/webp': 'webp'
}
const GIF_EXTS = Object.values(GIF_MIME_TO_EXT)

const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

function iconBasePath(): string {
  return join(brandingDir(), 'icon')
}

function gifBasePath(): string {
  return join(brandingDir(), 'running')
}

/** Parses a `data:<mime>;base64,<data>` string into its mime type and raw buffer. */
function parseDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) throw new Error('Expected a base64 data URL (data:<mime>;base64,...)')
  return { mime: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') }
}

async function findExisting(basePath: string, exts: string[]): Promise<string | null> {
  for (const ext of exts) {
    const path = `${basePath}.${ext}`
    try {
      await readFile(path)
      return path
    } catch {
      // try next extension
    }
  }
  return null
}

async function clearExisting(basePath: string, exts: string[]): Promise<void> {
  await Promise.all(
    exts.map((ext) =>
      unlink(`${basePath}.${ext}`).catch(() => {
        // ignore — file may not exist
      })
    )
  )
}

async function readAsDataUrl(path: string): Promise<string> {
  const ext = path.split('.').pop() ?? ''
  const mime = EXT_TO_MIME[ext] ?? 'application/octet-stream'
  const buf = await readFile(path)
  return `data:${mime};base64,${buf.toString('base64')}`
}

// ---------- Custom icon ----------

export async function customIconPath(): Promise<string | null> {
  return findExisting(iconBasePath(), ICON_EXTS)
}

export async function hasCustomIcon(): Promise<boolean> {
  return (await customIconPath()) !== null
}

export async function getCustomIconDataUrl(): Promise<string | null> {
  const path = await customIconPath()
  return path ? readAsDataUrl(path) : null
}

/** Validates + writes the uploaded icon to disk. Returns the new file path so callers can
 *  apply it to windows/tray immediately without a second disk read. */
export async function setCustomIcon(dataUrl: string): Promise<string> {
  const { mime, buffer } = parseDataUrl(dataUrl)
  const ext = ICON_MIME_TO_EXT[mime]
  if (!ext) throw new Error(`Unsupported icon type "${mime}" — please upload a PNG or JPEG image.`)
  await mkdir(brandingDir(), { recursive: true })
  await clearExisting(iconBasePath(), ICON_EXTS)
  const path = `${iconBasePath()}.${ext}`
  await writeFile(path, buffer)
  return path
}

export async function clearCustomIcon(): Promise<void> {
  await clearExisting(iconBasePath(), ICON_EXTS)
}

// ---------- Custom "AI is working" animation ----------

export async function customRunningGifPath(): Promise<string | null> {
  return findExisting(gifBasePath(), GIF_EXTS)
}

export async function hasCustomRunningGif(): Promise<boolean> {
  return (await customRunningGifPath()) !== null
}

export async function getCustomRunningGifDataUrl(): Promise<string | null> {
  const path = await customRunningGifPath()
  return path ? readAsDataUrl(path) : null
}

export async function setCustomRunningGif(dataUrl: string): Promise<void> {
  const { mime, buffer } = parseDataUrl(dataUrl)
  const ext = GIF_MIME_TO_EXT[mime]
  if (!ext) throw new Error(`Unsupported animation type "${mime}" — please upload a GIF or animated WebP.`)
  await mkdir(brandingDir(), { recursive: true })
  await clearExisting(gifBasePath(), GIF_EXTS)
  await writeFile(`${gifBasePath()}.${ext}`, buffer)
}

export async function clearCustomRunningGif(): Promise<void> {
  await clearExisting(gifBasePath(), GIF_EXTS)
}

/** Resolves the icon path to use for windows/tray — the custom one if set, otherwise the
 *  bundled default (build/icons/icon.png, resolved the same way ipc.ts/tray.ts already do). */
export async function resolveActiveIconPath(): Promise<string> {
  const custom = await customIconPath()
  if (custom) return custom
  return join(__dirname, '../../build/icons/icon.png')
}

/** Center-crops a non-square NativeImage down to a square (the smaller of width/height),
 *  so window/taskbar/dock/tray icons are never stretched, squished, or letterboxed with
 *  blank space when the source image isn't already square — matches how OSes expect a
 *  square icon and mirrors what most icon generators do. Square images pass through
 *  untouched. Empty images pass through untouched (caller already checks isEmpty()). */
export function centerCropToSquare(image: NativeImage): NativeImage {
  if (image.isEmpty()) return image
  const { width, height } = image.getSize()
  if (width === height) return image
  const size = Math.min(width, height)
  const x = Math.floor((width - size) / 2)
  const y = Math.floor((height - size) / 2)
  return image.crop({ x, y, width: size, height: size })
}

/** Loads the icon at `path` and center-crops it to a square (see centerCropToSquare) —
 *  the one place window/taskbar/dock/tray icon loading should go through. */
export function loadSquareIcon(path: string): NativeImage {
  return centerCropToSquare(nativeImage.createFromPath(path))
}
