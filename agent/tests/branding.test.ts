import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import './testElectronMock'
import { electronMockState } from './testElectronMock'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  customIconPath,
  hasCustomIcon,
  getCustomIconDataUrl,
  setCustomIcon,
  clearCustomIcon,
  customRunningGifPath,
  hasCustomRunningGif,
  getCustomRunningGifDataUrl,
  setCustomRunningGif,
  clearCustomRunningGif,
  resolveActiveIconPath
} = await import('../src/main/branding')

const tempDirs: string[] = []

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'klenny-branding-test-'))
  tempDirs.push(dir)
  electronMockState.userDataDir = dir
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

// A minimal valid 1x1 PNG, base64-encoded.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

// A minimal valid GIF89a header + trailer, base64-encoded, sufficient for this round-trip test
// (we never actually decode it as an image, just write/read the bytes).
const TINY_GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
const GIF_DATA_URL = `data:image/gif;base64,${TINY_GIF_BASE64}`

describe('branding — custom icon', () => {
  test('no custom icon set initially', async () => {
    expect(await hasCustomIcon()).toBe(false)
    expect(await customIconPath()).toBeNull()
    expect(await getCustomIconDataUrl()).toBeNull()
  })

  test('setCustomIcon writes the file and getCustomIconDataUrl round-trips it', async () => {
    await setCustomIcon(PNG_DATA_URL)
    expect(await hasCustomIcon()).toBe(true)
    const path = await customIconPath()
    expect(path).not.toBeNull()
    expect(path!.endsWith('.png')).toBe(true)

    const dataUrl = await getCustomIconDataUrl()
    expect(dataUrl).toBe(PNG_DATA_URL)
  })

  test('setCustomIcon rejects unsupported mime types (e.g. SVG)', async () => {
    await expect(setCustomIcon('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).rejects.toThrow(/Unsupported icon type/)
  })

  test('setCustomIcon rejects a malformed data URL', async () => {
    await expect(setCustomIcon('not-a-data-url')).rejects.toThrow(/base64 data URL/)
  })

  test('re-uploading a different format replaces the previous file, not adds to it', async () => {
    await setCustomIcon(PNG_DATA_URL)
    const jpegDataUrl = `data:image/jpeg;base64,${TINY_PNG_BASE64}`
    await setCustomIcon(jpegDataUrl)
    const path = await customIconPath()
    expect(path!.endsWith('.jpg')).toBe(true)
  })

  test('clearCustomIcon removes the file and falls back to null', async () => {
    await setCustomIcon(PNG_DATA_URL)
    await clearCustomIcon()
    expect(await hasCustomIcon()).toBe(false)
    expect(await getCustomIconDataUrl()).toBeNull()
  })

  test('resolveActiveIconPath returns the custom path when set, default bundled path otherwise', async () => {
    const defaultPath = await resolveActiveIconPath()
    expect(defaultPath).toContain('icon.png')
    expect(defaultPath.startsWith(electronMockState.userDataDir)).toBe(false)

    await setCustomIcon(PNG_DATA_URL)
    const customPath = await resolveActiveIconPath()
    expect(customPath.startsWith(electronMockState.userDataDir)).toBe(true)
  })
})

describe('branding — custom "AI is working" animation', () => {
  test('no custom running gif set initially', async () => {
    expect(await hasCustomRunningGif()).toBe(false)
    expect(await customRunningGifPath()).toBeNull()
    expect(await getCustomRunningGifDataUrl()).toBeNull()
  })

  test('setCustomRunningGif writes the file and getCustomRunningGifDataUrl round-trips it', async () => {
    await setCustomRunningGif(GIF_DATA_URL)
    expect(await hasCustomRunningGif()).toBe(true)
    const dataUrl = await getCustomRunningGifDataUrl()
    expect(dataUrl).toBe(GIF_DATA_URL)
  })

  test('setCustomRunningGif rejects unsupported mime types (e.g. PNG)', async () => {
    await expect(setCustomRunningGif(PNG_DATA_URL)).rejects.toThrow(/Unsupported animation type/)
  })

  test('clearCustomRunningGif removes the file', async () => {
    await setCustomRunningGif(GIF_DATA_URL)
    await clearCustomRunningGif()
    expect(await hasCustomRunningGif()).toBe(false)
  })

  test('icon and running-gif storage are independent of each other', async () => {
    await setCustomIcon(PNG_DATA_URL)
    await setCustomRunningGif(GIF_DATA_URL)
    expect(await hasCustomIcon()).toBe(true)
    expect(await hasCustomRunningGif()).toBe(true)

    await clearCustomIcon()
    expect(await hasCustomIcon()).toBe(false)
    expect(await hasCustomRunningGif()).toBe(true)
  })
})
