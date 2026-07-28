// Coverage for the read_image tool (agent/src/main/agent/tools/image.ts) — a global, read-only
// tool that reads an arbitrary image file from disk and returns it as a data URL, mirroring how
// user-pasted/attached images are represented (see ImageBlock in shared/types.ts).
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere

let workspaceDir: string

// A minimal valid 2x1 red/blue PNG (IHDR width=2, height=1), built by hand so the test can assert
// on sniffed dimensions without depending on any image-encoding library.
const MINIMAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAA3xI5NAAAAEUlEQVR4AWNgYPjPMHz4MAADAgEAX8DwPQAAAABJRU5ErkJggg=='

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-image-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-image-'))
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)

  await writeFile(join(workspaceDir, 'photo.png'), Buffer.from(MINIMAL_PNG_BASE64, 'base64'))
  await writeFile(join(workspaceDir, 'notes.txt'), 'not an image')
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('read_image tool', () => {
  test('reads a PNG and returns a data URL with sniffed dimensions', async () => {
    const { readImageTool } = await import('../src/main/agent/tools/image')
    const result = await readImageTool({ path: 'photo.png' })
    expect(result.ok).toBe(true)
    const data = result.data as { mimeType: string; dataUrl: string; width?: number; height?: number; sizeBytes: number }
    expect(data.mimeType).toBe('image/png')
    expect(data.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(data.width).toBe(2)
    expect(data.height).toBe(1)
    expect(data.sizeBytes).toBeGreaterThan(0)
  })

  test('rejects an unrecognized extension without reading the file', async () => {
    const { readImageTool } = await import('../src/main/agent/tools/image')
    const result = await readImageTool({ path: 'notes.txt' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('unsupported_type')
  })

  test('reports not_found for a missing file', async () => {
    const { readImageTool } = await import('../src/main/agent/tools/image')
    const result = await readImageTool({ path: 'missing.png' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_found')
  })

  test('resolves an absolute path outside the workspace (global read, like read_file)', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'klenny-image-outside-'))
    try {
      const abs = join(outsideDir, 'external.png')
      await writeFile(abs, Buffer.from(MINIMAL_PNG_BASE64, 'base64'))
      const { readImageTool } = await import('../src/main/agent/tools/image')
      const result = await readImageTool({ path: abs })
      expect(result.ok).toBe(true)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})
