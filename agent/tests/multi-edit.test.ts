import { describe, expect, test, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere

let workspaceDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-multiedit-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-multiedit-'))
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterEach(async () => {
  // Each test manages its own files; nothing to reset globally, but keep the hook here in
  // case future tests need per-test cleanup without tearing down the whole workspace.
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('multiEditFileTool', () => {
  test('applies multiple edits to the same file atomically', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const rel = 'same-file.ts'
    await writeFile(join(workspaceDir, rel), 'const a = 1\nconst b = 2\nconst c = 3\n', 'utf8')

    const result = await multiEditFileTool({
      edits: [
        { path: rel, old_string: 'const a = 1', new_string: 'const a = 10' },
        { path: rel, old_string: 'const c = 3', new_string: 'const c = 30' }
      ]
    })

    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(workspaceDir, rel), 'utf8')
    expect(onDisk).toBe('const a = 10\nconst b = 2\nconst c = 30\n')
  })

  test('a later edit can target text produced by an earlier edit to the same file', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const rel = 'chained.ts'
    await writeFile(join(workspaceDir, rel), 'export const value = 1\n', 'utf8')

    const result = await multiEditFileTool({
      edits: [
        { path: rel, old_string: 'value = 1', new_string: 'value = 2' },
        { path: rel, old_string: 'value = 2', new_string: 'value = 3' }
      ]
    })

    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(workspaceDir, rel), 'utf8')
    expect(onDisk).toBe('export const value = 3\n')
  })

  test('applies edits across multiple files', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    await mkdir(join(workspaceDir, 'multi'), { recursive: true })
    const relA = 'multi/a.ts'
    const relB = 'multi/b.ts'
    await writeFile(join(workspaceDir, relA), 'export const a = "old-a"\n', 'utf8')
    await writeFile(join(workspaceDir, relB), 'export const b = "old-b"\n', 'utf8')

    const result = await multiEditFileTool({
      edits: [
        { path: relA, old_string: 'old-a', new_string: 'new-a' },
        { path: relB, old_string: 'old-b', new_string: 'new-b' }
      ]
    })

    expect(result.ok).toBe(true)
    expect((result.data as { paths: string[] }).paths.sort()).toEqual([relA, relB].sort())
    expect(await readFile(join(workspaceDir, relA), 'utf8')).toBe('export const a = "new-a"\n')
    expect(await readFile(join(workspaceDir, relB), 'utf8')).toBe('export const b = "new-b"\n')
  })

  test('is all-or-nothing: if one edit fails to match, no file in the batch is written', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    await mkdir(join(workspaceDir, 'atomic'), { recursive: true })
    const relA = 'atomic/a.ts'
    const relB = 'atomic/b.ts'
    await writeFile(join(workspaceDir, relA), 'export const a = "keep-a"\n', 'utf8')
    await writeFile(join(workspaceDir, relB), 'export const b = "keep-b"\n', 'utf8')

    const result = await multiEditFileTool({
      edits: [
        { path: relA, old_string: 'keep-a', new_string: 'changed-a' },
        { path: relB, old_string: 'this text does not exist', new_string: 'changed-b' }
      ]
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('not_found')
    // Neither file should have been touched, including relA whose edit was valid.
    expect(await readFile(join(workspaceDir, relA), 'utf8')).toBe('export const a = "keep-a"\n')
    expect(await readFile(join(workspaceDir, relB), 'utf8')).toBe('export const b = "keep-b"\n')
  })

  test('rejects an ambiguous match unless replace_all is set', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const rel = 'ambiguous.ts'
    await writeFile(join(workspaceDir, rel), 'foo\nfoo\n', 'utf8')

    const ambiguous = await multiEditFileTool({
      edits: [{ path: rel, old_string: 'foo', new_string: 'bar' }]
    })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.error).toBe('ambiguous')

    const replaceAll = await multiEditFileTool({
      edits: [{ path: rel, old_string: 'foo', new_string: 'bar', replace_all: true }]
    })
    expect(replaceAll.ok).toBe(true)
    expect(await readFile(join(workspaceDir, rel), 'utf8')).toBe('bar\nbar\n')
  })

  test('errors with no_edits when called with an empty batch', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiEditFileTool({ edits: [] })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_edits')
  })

  test('rejects paths outside the workspace', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiEditFileTool({
      edits: [{ path: '../outside.ts', old_string: 'a', new_string: 'b' }]
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('sandbox')
  })

  test('rejects a malformed edit (missing path) with a clean error instead of throwing', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const rel = 'malformed.ts'
    await writeFile(join(workspaceDir, rel), 'const a = 1\n', 'utf8')

    const result = await multiEditFileTool({
      edits: [
        { path: rel, old_string: 'const a = 1', new_string: 'const a = 10' },
        // Missing `path` on a second edit to the same file — a real quirk seen from some
        // models on repeated-edit batches. Must not crash the tool.
        { old_string: 'const a = 10', new_string: 'const a = 100' } as unknown as {
          path: string
          old_string: string
          new_string: string
        }
      ]
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_edit')
    // Nothing should have been written — the batch is all-or-nothing.
    expect(await readFile(join(workspaceDir, rel), 'utf8')).toBe('const a = 1\n')
  })

  test('parses edits when sent as a valid JSON-encoded string instead of a real array', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const rel = 'stringified-edits.ts'
    await writeFile(join(workspaceDir, rel), 'const a = 1\n', 'utf8')

    const result = await multiEditFileTool({
      edits: JSON.stringify([{ path: rel, old_string: 'const a = 1', new_string: 'const a = 10' }]) as unknown as never
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, rel), 'utf8')).toBe('const a = 10\n')
  })

  test('rejects edits sent as a string that is not valid JSON', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiEditFileTool({
      edits: 'not json at all {' as unknown as never
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_edits')
    expect(result.summary).toContain('not valid JSON')
  })

  test('rejects edits sent as a JSON string that parses to a non-array', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiEditFileTool({
      edits: JSON.stringify({ path: 'whatever.ts', old_string: 'a', new_string: 'b' }) as unknown as never
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_edits')
    expect(result.summary).toContain('did not parse to an array')
  })

  test('still reports no_edits (without throwing) when edits is neither an array nor a string', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiEditFileTool({ edits: 42 as unknown as never })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_edits')
  })

  test('a top-level "path" fills in edits that omit their own path', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const rel = 'default-path.ts'
    await writeFile(join(workspaceDir, rel), 'const a = 1\nconst b = 2\n', 'utf8')

    const result = await multiEditFileTool({
      path: rel,
      edits: [
        { old_string: 'const a = 1', new_string: 'const a = 10' } as unknown as {
          path: string
          old_string: string
          new_string: string
        },
        { old_string: 'const b = 2', new_string: 'const b = 20' } as unknown as {
          path: string
          old_string: string
          new_string: string
        }
      ]
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, rel), 'utf8')).toBe('const a = 10\nconst b = 20\n')
  })

  test('a per-edit "path" overrides the top-level default, so mixed-file batches still work', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    await mkdir(join(workspaceDir, 'default-path-mixed'), { recursive: true })
    const relA = 'default-path-mixed/a.ts'
    const relB = 'default-path-mixed/b.ts'
    await writeFile(join(workspaceDir, relA), 'export const a = "old-a"\n', 'utf8')
    await writeFile(join(workspaceDir, relB), 'export const b = "old-b"\n', 'utf8')

    const result = await multiEditFileTool({
      path: relA,
      edits: [
        { old_string: 'old-a', new_string: 'new-a' } as unknown as { path: string; old_string: string; new_string: string },
        { path: relB, old_string: 'old-b', new_string: 'new-b' }
      ]
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, relA), 'utf8')).toBe('export const a = "new-a"\n')
    expect(await readFile(join(workspaceDir, relB), 'utf8')).toBe('export const b = "new-b"\n')
  })

  test('without a top-level "path", an edit missing its own path still fails cleanly', async () => {
    const { multiEditFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiEditFileTool({
      edits: [{ old_string: 'a', new_string: 'b' } as unknown as { path: string; old_string: string; new_string: string }]
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('invalid_edit')
  })
})

describe('previewMultiEdit', () => {
  test('computes a combined diff across files without writing to disk', async () => {
    const { previewMultiEdit } = await import('../src/main/agent/tools/index')
    await mkdir(join(workspaceDir, 'preview'), { recursive: true })
    const relA = 'preview/a.ts'
    const relB = 'preview/b.ts'
    await writeFile(join(workspaceDir, relA), 'export const a = "before-a"\n', 'utf8')
    await writeFile(join(workspaceDir, relB), 'export const b = "before-b"\n', 'utf8')

    const { paths, diff } = await previewMultiEdit([
      { path: relA, old_string: 'before-a', new_string: 'after-a' },
      { path: relB, old_string: 'before-b', new_string: 'after-b' }
    ])

    expect(paths.sort()).toEqual([relA, relB].sort())
    expect(diff).toContain('before-a')
    expect(diff).toContain('after-a')
    expect(diff).toContain('before-b')
    expect(diff).toContain('after-b')

    // Nothing should have been written — this is a dry run only.
    expect(await readFile(join(workspaceDir, relA), 'utf8')).toBe('export const a = "before-a"\n')
    expect(await readFile(join(workspaceDir, relB), 'utf8')).toBe('export const b = "before-b"\n')
  })

  test('degrades gracefully instead of throwing when an edit is malformed', async () => {
    const { previewMultiEdit } = await import('../src/main/agent/tools/index')
    // Used to throw a raw, uncaught TypeError out of resolveWorkspacePath when `path` was
    // missing — which crashed the whole agent turn during the pre-approval preview step
    // (see "multi_edit tool broken" fix). Must now resolve to a plain, empty-ish preview.
    const { paths, diff } = await previewMultiEdit([
      { old_string: 'a', new_string: 'b' } as unknown as { path: string; old_string: string; new_string: string }
    ])
    expect(Array.isArray(paths)).toBe(true)
    expect(diff).toBeUndefined()
  })
})
