import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadManifest, saveManifest, embeddingsModelMismatch, type IndexManifest } from '../src/main/agent/codeindex/manifest'

const tempDirs: string[] = []

async function makeTempManifestPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'klenny-manifest-test-'))
  tempDirs.push(dir)
  return join(dir, 'manifest.json')
}

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('loadManifest / saveManifest', () => {
  test('loadManifest returns an empty manifest when the file does not exist', async () => {
    const path = await makeTempManifestPath()
    const manifest = await loadManifest(path)
    expect(manifest).toEqual({ embeddingsModel: null, files: {} })
  })

  test('saveManifest then loadManifest round-trips correctly', async () => {
    const path = await makeTempManifestPath()
    const manifest: IndexManifest = {
      embeddingsModel: 'qwen/qwen3-embedding-8b',
      files: { 'src/foo.ts': [{ id: 'abc', hash: 'h1' }] }
    }
    await saveManifest(path, manifest)
    const loaded = await loadManifest(path)
    expect(loaded).toEqual(manifest)
  })

  test('loadManifest tolerates a partial/older-shape file (fills in defaults)', async () => {
    const path = await makeTempManifestPath()
    await saveManifest(path, { embeddingsModel: null, files: {} })
    // Simulate a manifest missing the `files` key by writing raw JSON directly.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, JSON.stringify({ embeddingsModel: 'some/model' }), 'utf8')
    const loaded = await loadManifest(path)
    expect(loaded.embeddingsModel).toBe('some/model')
    expect(loaded.files).toEqual({})
  })
})

describe('embeddingsModelMismatch', () => {
  test('no mismatch when manifest has never been built (embeddingsModel is null)', () => {
    expect(embeddingsModelMismatch({ embeddingsModel: null, files: {} }, 'qwen/qwen3-embedding-8b')).toBe(false)
  })

  test('no mismatch when the manifest model matches the current model', () => {
    expect(
      embeddingsModelMismatch({ embeddingsModel: 'qwen/qwen3-embedding-8b', files: {} }, 'qwen/qwen3-embedding-8b')
    ).toBe(false)
  })

  test('mismatch when the manifest model differs from the current model — must force a rebuild', () => {
    expect(
      embeddingsModelMismatch({ embeddingsModel: 'qwen/qwen3-embedding-8b', files: { 'a.ts': [{ id: '1', hash: 'h' }] } }, 'openai/text-embedding-3-small')
    ).toBe(true)
  })
})
