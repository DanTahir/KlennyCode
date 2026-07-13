import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import fg from 'fast-glob'
import ignore from 'ignore'

type Ignore = ReturnType<typeof ignore>

export const ALWAYS_IGNORE_DIRS = ['node_modules', '.git', 'dist', 'build', '.klenny', 'coverage']
const ALWAYS_IGNORE = ALWAYS_IGNORE_DIRS.map((d) => `**/${d}/**`)

const MAX_FILE_BYTES = 1_000_000 // 1MB guard — skip huge generated/data files

// A conservative denylist of common binary/non-text extensions. We also do a NUL-byte sniff
// on the first chunk of each file as a second line of defense against anything not caught here.
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.webm', '.flac',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.pdf',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  '.db', '.sqlite', '.sqlite3', '.lock',
  '.node', '.pyc', '.class', '.jar'
])

// Cached per root so the watcher's frequent single-file checks don't re-read .gitignore from
// disk on every event. Callers that care about picking up mid-session .gitignore edits should
// call `invalidateGitignoreCache(root)` (the manager does this on every full re-scan).
const gitignoreCache = new Map<string, Ignore>()

export function invalidateGitignoreCache(root: string): void {
  gitignoreCache.delete(root)
}

async function loadGitignore(root: string): Promise<Ignore> {
  const cached = gitignoreCache.get(root)
  if (cached) return cached
  const ig = ignore()
  try {
    const content = await readFile(join(root, '.gitignore'), 'utf8')
    ig.add(content)
  } catch {
    // no .gitignore — that's fine
  }
  gitignoreCache.set(root, ig)
  return ig
}

function hasBinaryExtension(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase())
}

function looksBinary(buf: Buffer): boolean {
  // Sniff the first 8KB for NUL bytes — a reliable enough heuristic for "not text".
  const sample = buf.subarray(0, 8192)
  return sample.includes(0)
}

/**
 * Lists workspace files eligible for indexing: respects the same always-ignored dirs as
 * grep/glob tools, plus the workspace's own .gitignore, plus a binary/oversized-file guard
 * so we don't waste embedding budget on images, lockfiles, or generated data blobs.
 */
export async function listIndexableFiles(root: string): Promise<string[]> {
  const ig = await loadGitignore(root)
  const candidates = await fg('**/*', {
    cwd: root,
    absolute: false,
    dot: false,
    onlyFiles: true,
    ignore: ALWAYS_IGNORE
  })

  const out: string[] = []
  for (const rel of candidates) {
    if (ig.ignores(rel)) continue
    if (hasBinaryExtension(rel)) continue
    try {
      const abs = join(root, rel)
      const st = await stat(abs)
      if (st.size === 0 || st.size > MAX_FILE_BYTES) continue
      out.push(rel)
    } catch {
      // file may have been removed mid-scan — skip
    }
  }
  return out
}

/** Reads a file's text content, or returns null if it's binary/unreadable (defense in depth beyond the extension check). */
export async function readIndexableFile(absPath: string): Promise<string | null> {
  try {
    const buf = await readFile(absPath)
    if (looksBinary(buf)) return null
    return buf.toString('utf8')
  } catch {
    return null
  }
}

/**
 * Same eligibility rules as `listIndexableFiles`, applied to a single relative path — used by
 * the live watcher so a single file-change event doesn't require re-listing the whole workspace.
 */
export async function isFileIndexable(root: string, relPath: string): Promise<boolean> {
  const normalized = relPath.split('\\').join('/')
  if (ALWAYS_IGNORE_DIRS.some((d) => normalized === d || normalized.startsWith(`${d}/`))) return false
  const ig = await loadGitignore(root)
  if (ig.ignores(normalized)) return false
  if (hasBinaryExtension(normalized)) return false
  try {
    const st = await stat(join(root, normalized))
    if (!st.isFile()) return false
    if (st.size === 0 || st.size > MAX_FILE_BYTES) return false
    return true
  } catch {
    return false
  }
}
