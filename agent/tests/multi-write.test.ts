import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere

let workspaceDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-multiwrite-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-multiwrite-'))
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null) // avoid leaking workspace state into other test files sharing this process
  await rm(workspaceDir, { recursive: true, force: true })
})

describe('multiWriteFileTool', () => {
  test('writes several brand-new files in one call, creating parent directories', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')

    const result = await multiWriteFileTool({
      files: [
        { path: 'scaffold/src/index.ts', content: 'export const hello = "world"\n' },
        { path: 'scaffold/src/util/math.ts', content: 'export const add = (a: number, b: number) => a + b\n' },
        { path: 'scaffold/README.md', content: '# Scaffold\n' }
      ]
    })

    expect(result.ok).toBe(true)
    expect((result.data as { paths: string[] }).paths.length).toBe(3)
    expect(await readFile(join(workspaceDir, 'scaffold/src/index.ts'), 'utf8')).toBe('export const hello = "world"\n')
    expect(await readFile(join(workspaceDir, 'scaffold/src/util/math.ts'), 'utf8')).toBe(
      'export const add = (a: number, b: number) => a + b\n'
    )
    expect(await readFile(join(workspaceDir, 'scaffold/README.md'), 'utf8')).toBe('# Scaffold\n')
  })

  test('summary distinguishes created from overwritten files', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    await mkdir(join(workspaceDir, 'mixed'), { recursive: true })
    await writeFile(join(workspaceDir, 'mixed/existing.txt'), 'old\n', 'utf8')

    const result = await multiWriteFileTool({
      files: [
        { path: 'mixed/existing.txt', content: 'new\n' },
        { path: 'mixed/fresh.txt', content: 'fresh\n' }
      ]
    })

    expect(result.ok).toBe(true)
    expect(result.summary).toContain('1 created')
    expect(result.summary).toContain('1 overwritten')
    expect(await readFile(join(workspaceDir, 'mixed/existing.txt'), 'utf8')).toBe('new\n')
  })

  test('is all-or-nothing: a sandbox violation anywhere writes nothing at all', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')

    const result = await multiWriteFileTool({
      files: [
        { path: 'atomic-write/good.txt', content: 'should not survive\n' },
        { path: '../escape.txt', content: 'nope\n' }
      ]
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('sandbox')
    // The first (valid) entry must NOT have been written.
    await expect(readFile(join(workspaceDir, 'atomic-write/good.txt'), 'utf8')).rejects.toThrow()
  })

  test('preserves an existing file\'s CRLF line endings instead of rewriting them to LF', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    await mkdir(join(workspaceDir, 'eol'), { recursive: true })
    await writeFile(join(workspaceDir, 'eol/crlf.txt'), 'line one\r\nline two\r\n', 'utf8')

    const result = await multiWriteFileTool({
      files: [{ path: 'eol/crlf.txt', content: 'replaced one\nreplaced two\n' }]
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'eol/crlf.txt'), 'utf8')).toBe('replaced one\r\nreplaced two\r\n')
  })

  test('an explicit empty string content writes a genuinely empty file', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({ files: [{ path: 'empty/blank.txt', content: '' }] })
    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'empty/blank.txt'), 'utf8')).toBe('')
  })

  test('the same path twice in one batch is last-write-wins, counted as one file', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({
      files: [
        { path: 'dupe/a.txt', content: 'first\n' },
        { path: './dupe/a.txt', content: 'second\n' }
      ]
    })

    expect(result.ok).toBe(true)
    expect((result.data as { paths: string[] }).paths.length).toBe(1)
    expect(await readFile(join(workspaceDir, 'dupe/a.txt'), 'utf8')).toBe('second\n')
  })

  test('errors with no_files on an empty batch and on a missing files arg', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const empty = await multiWriteFileTool({ files: [] })
    expect(empty.ok).toBe(false)
    expect(empty.error).toBe('no_files')

    const missing = await multiWriteFileTool({})
    expect(missing.ok).toBe(false)
    expect(missing.error).toBe('no_files')
  })

  test('a malformed entry fails cleanly (no throw) and writes nothing', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({
      files: [
        { path: 'malformed/ok.txt', content: 'ok\n' },
        { path: 'malformed/bad.txt' } // no content at all
      ]
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_files')
    expect(result.summary).toContain('index 1')
    await expect(readFile(join(workspaceDir, 'malformed/ok.txt'), 'utf8')).rejects.toThrow()
  })

  test('a null content is rejected rather than silently truncating the file', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    await mkdir(join(workspaceDir, 'nulled'), { recursive: true })
    await writeFile(join(workspaceDir, 'nulled/keep.txt'), 'precious\n', 'utf8')

    const result = await multiWriteFileTool({
      files: [{ path: 'nulled/keep.txt', content: null as unknown as string }]
    })

    expect(result.ok).toBe(false)
    expect(await readFile(join(workspaceDir, 'nulled/keep.txt'), 'utf8')).toBe('precious\n')
  })
})

// The whole point of normalizeFilesArg: models mangle batch-array arguments in a handful of
// predictable ways (see its doc comment in tools/file-ops.ts). Each of these shapes must work
// rather than erroring or, worse, writing garbage.
describe('multiWriteFileTool — tolerated malformed argument shapes', () => {
  test('files sent as a JSON-encoded string instead of a real array', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({
      files: JSON.stringify([{ path: 'shapes/stringified.txt', content: 'from a string\n' }])
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'shapes/stringified.txt'), 'utf8')).toBe('from a string\n')
  })

  test('a single entry object not wrapped in an array', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({
      files: { path: 'shapes/single.txt', content: 'unwrapped\n' }
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'shapes/single.txt'), 'utf8')).toBe('unwrapped\n')
  })

  test('a path -> content map instead of an array of entries', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({
      files: {
        'shapes/map-a.txt': 'map a\n',
        'shapes/map-b.txt': 'map b\n'
      }
    })

    expect(result.ok).toBe(true)
    expect((result.data as { paths: string[] }).paths.sort()).toEqual(['shapes/map-a.txt', 'shapes/map-b.txt'])
    expect(await readFile(join(workspaceDir, 'shapes/map-a.txt'), 'utf8')).toBe('map a\n')
    expect(await readFile(join(workspaceDir, 'shapes/map-b.txt'), 'utf8')).toBe('map b\n')
  })

  test('the degenerate single-file form: top-level path/content with no files array', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({ path: 'shapes/toplevel.txt', content: 'top level\n' })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'shapes/toplevel.txt'), 'utf8')).toBe('top level\n')
  })

  test('per-entry key aliases (file_path / text)', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({
      files: [
        { file_path: 'shapes/alias-a.txt', text: 'alias a\n' },
        { filename: 'shapes/alias-b.txt', body: 'alias b\n' },
        { file: 'shapes/alias-c.txt', code: 'alias c\n' }
      ]
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'shapes/alias-a.txt'), 'utf8')).toBe('alias a\n')
    expect(await readFile(join(workspaceDir, 'shapes/alias-b.txt'), 'utf8')).toBe('alias b\n')
    expect(await readFile(join(workspaceDir, 'shapes/alias-c.txt'), 'utf8')).toBe('alias c\n')
  })

  test('content sent as an array of lines is joined with newlines', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({
      files: [{ path: 'shapes/lines.txt', content: ['first', 'second', 'third'] }]
    })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'shapes/lines.txt'), 'utf8')).toBe('first\nsecond\nthird')
  })

  test('content sent as an object is serialized as pretty JSON', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({
      files: [{ path: 'shapes/config.json', content: { name: 'pkg', version: '1.0.0' } }]
    })

    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(workspaceDir, 'shapes/config.json'), 'utf8')
    expect(JSON.parse(onDisk)).toEqual({ name: 'pkg', version: '1.0.0' })
    expect(onDisk).toContain('\n  "name"') // pretty-printed, not minified
  })

  test('content sent as a number is stringified', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({ files: [{ path: 'shapes/port.txt', content: 8080 }] })

    expect(result.ok).toBe(true)
    expect(await readFile(join(workspaceDir, 'shapes/port.txt'), 'utf8')).toBe('8080')
  })

  test('files as a string that is not valid JSON reports a clear error', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({ files: 'not json at all {' })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_files')
    expect(result.summary).toContain('not valid JSON')
  })

  test('files as a JSON string parsing to a scalar reports a clear error', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({ files: JSON.stringify(42) })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_files')
    expect(result.summary).toContain('did not parse to an array or object')
  })

  test('files as a bare non-array scalar reports a clear error without throwing', async () => {
    const { multiWriteFileTool } = await import('../src/main/agent/tools/index')
    const result = await multiWriteFileTool({ files: 42 as unknown as never })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('no_files')
  })
})

describe('normalizeFilesArg', () => {
  test('trims whitespace around paths', async () => {
    const { normalizeFilesArg } = await import('../src/main/agent/tools/index')
    const result = normalizeFilesArg([{ path: '  spaced/out.txt  ', content: 'x' }])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.files[0].path).toBe('spaced/out.txt')
  })

  test('reports the offending index for a malformed entry', async () => {
    const { normalizeFilesArg } = await import('../src/main/agent/tools/index')
    const result = normalizeFilesArg([{ path: 'a.txt', content: 'a' }, { content: 'no path' }])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.summary).toContain('index 1')
  })
})

describe('previewMultiWrite', () => {
  test('computes a combined diff across files without writing to disk', async () => {
    const { previewMultiWrite } = await import('../src/main/agent/tools/index')
    await mkdir(join(workspaceDir, 'preview-write'), { recursive: true })
    await writeFile(join(workspaceDir, 'preview-write/existing.txt'), 'before\n', 'utf8')

    const { paths, diff } = await previewMultiWrite([
      { path: 'preview-write/existing.txt', content: 'after\n' },
      { path: 'preview-write/brand-new.txt', content: 'created\n' }
    ])

    expect(paths.sort()).toEqual(['preview-write/brand-new.txt', 'preview-write/existing.txt'])
    expect(diff).toContain('before')
    expect(diff).toContain('after')
    expect(diff).toContain('created')

    // Dry run only — the existing file is untouched and the new one was never created.
    expect(await readFile(join(workspaceDir, 'preview-write/existing.txt'), 'utf8')).toBe('before\n')
    await expect(readFile(join(workspaceDir, 'preview-write/brand-new.txt'), 'utf8')).rejects.toThrow()
  })

  test('degrades to a bare path list instead of throwing when an entry is malformed', async () => {
    const { previewMultiWrite } = await import('../src/main/agent/tools/index')
    const { paths, diff } = await previewMultiWrite([
      { content: 'no path here' } as unknown as { path: string; content: string }
    ])
    expect(Array.isArray(paths)).toBe(true)
    expect(diff).toBeUndefined()
  })
})
