import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  invalidateGitignoreCache,
  isFileIndexable,
  isGitignoreFile,
  isIgnoredPath,
  listIndexableFiles
} from '../src/main/agent/codeindex/filewalker'
import { CodeIndexWatcher } from '../src/main/agent/codeindex/watcher'

const tempDirs: string[] = []

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'klenny-filewalker-test-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }
  return root
}

describe('isIgnoredPath (shared by the full scan and the watcher)', () => {
  test('ignores always-ignored dirs at ANY depth, not just the root', () => {
    expect(isIgnoredPath('node_modules/x/index.js')).toBe(true)
    expect(isIgnoredPath('packages/app/node_modules/x/index.js')).toBe(true)
    expect(isIgnoredPath('services/api/.venv/lib/site.py')).toBe(true)
    expect(isIgnoredPath('py/pkg/__pycache__/mod.cpython-311.pyc')).toBe(true)
    expect(isIgnoredPath('web/.next/server/page.js')).toBe(true)
  })

  test('ignores dot-dirs, dot-files, logs and build artifacts', () => {
    expect(isIgnoredPath('.idea/workspace.xml')).toBe(true)
    expect(isIgnoredPath('src/.hidden/file.ts')).toBe(true)
    expect(isIgnoredPath('.env')).toBe(true)
    expect(isIgnoredPath('logs/server.log')).toBe(true)
    expect(isIgnoredPath('app.LOG')).toBe(true)
    expect(isIgnoredPath('public/bundle.min.js')).toBe(true)
    expect(isIgnoredPath('public/bundle.js.map')).toBe(true)
  })

  test('accepts ordinary source paths, including Windows separators', () => {
    expect(isIgnoredPath('src/main/index.ts')).toBe(false)
    expect(isIgnoredPath('src\\main\\index.ts')).toBe(false)
    expect(isIgnoredPath('README.md')).toBe(false)
    // a FILE named like an ignored dir is not itself ignored
    expect(isIgnoredPath('scripts/build')).toBe(false)
  })

  test('isGitignoreFile recognises root and nested .gitignore files', () => {
    expect(isGitignoreFile('.gitignore')).toBe(true)
    expect(isGitignoreFile('pkg/.gitignore')).toBe(true)
    expect(isGitignoreFile('pkg\\.gitignore')).toBe(true)
    expect(isGitignoreFile('gitignore.md')).toBe(false)
  })
})

describe('listIndexableFiles / isFileIndexable', () => {
  test('apply nested .gitignore files relative to their own directory, and agree with each other', async () => {
    const root = await makeTree({
      '.gitignore': 'secret.txt\n',
      'src/a.ts': 'export const a = 1\n',
      'secret.txt': 'nope\n',
      'pkg/.gitignore': 'generated/\n*.tmp.ts\n',
      'pkg/keep.ts': 'export {}\n',
      'pkg/generated/out.ts': 'export {}\n',
      'pkg/x.tmp.ts': 'export {}\n',
      'other/generated/fine.ts': 'export {}\n',
      'pkg/node_modules/dep/index.js': 'module.exports = 1\n',
      'debug.log': 'log line\n',
      'empty.ts': ''
    })
    invalidateGitignoreCache(root)
    const files = (await listIndexableFiles(root)).sort()
    expect(files).toEqual(['other/generated/fine.ts', 'pkg/keep.ts', 'src/a.ts'])

    for (const rel of ['other/generated/fine.ts', 'pkg/keep.ts', 'src/a.ts']) {
      expect(await isFileIndexable(root, rel)).toBe(true)
    }
    for (const rel of ['secret.txt', 'pkg/generated/out.ts', 'pkg/x.tmp.ts', 'pkg/node_modules/dep/index.js', 'debug.log', 'empty.ts', 'missing.ts']) {
      expect(await isFileIndexable(root, rel)).toBe(false)
    }
  })

  test('invalidateGitignoreCache picks up an edited .gitignore', async () => {
    const root = await makeTree({ 'a.ts': 'export {}\n', 'b.ts': 'export {}\n' })
    invalidateGitignoreCache(root)
    expect(await isFileIndexable(root, 'b.ts')).toBe(true)
    await writeFile(join(root, '.gitignore'), 'b.ts\n', 'utf8')
    // still cached
    expect(await isFileIndexable(root, 'b.ts')).toBe(true)
    invalidateGitignoreCache(root)
    expect(await isFileIndexable(root, 'b.ts')).toBe(false)
  })
})

describe('CodeIndexWatcher batching', () => {
  function collect(opts = { debounceMs: 20, maxWaitMs: 200, maxPending: 3 }) {
    const batches: string[][] = []
    let gitignore = 0
    let overflow = 0
    const watcher = new CodeIndexWatcher('/unused-root', {
      onBatch: (paths) => batches.push(paths),
      onGitignoreChanged: () => gitignore++,
      onOverflow: () => overflow++
    }, opts)
    return { watcher, batches, counts: () => ({ gitignore, overflow }) }
  }
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test('coalesces repeated events into one deduplicated batch and drops ignored paths', async () => {
    const { watcher, batches } = collect()
    watcher.ingest('src\\a.ts')
    watcher.ingest('src/a.ts')
    watcher.ingest('src/b.ts')
    watcher.ingest('packages/x/node_modules/y/index.js')
    watcher.ingest('server.log')
    watcher.ingest('.git/index')
    await sleep(60)
    expect(batches).toEqual([['src/a.ts', 'src/b.ts']])
    watcher.stop()
  })

  test('reports .gitignore edits separately and overflow instead of a huge batch', async () => {
    const { watcher, batches, counts } = collect()
    watcher.ingest('pkg/.gitignore')
    watcher.ingest('node_modules/dep/.gitignore')
    await sleep(60)
    expect(counts()).toEqual({ gitignore: 1, overflow: 0 })
    for (const f of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) watcher.ingest(f)
    await sleep(60)
    expect(counts().overflow).toBe(1)
    expect(batches).toEqual([])
    watcher.stop()
  })
})
