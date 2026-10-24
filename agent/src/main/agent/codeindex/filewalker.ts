import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import fg from 'fast-glob'
import ignore from 'ignore'

type Ignore = ReturnType<typeof ignore>

/**
 * Directory names that are never indexed, wherever they appear in the tree (not just at the
 * root). They hold dependencies, VCS data, build output, virtualenvs or caches: large, generated,
 * and useless for semantic search.
 */
export const ALWAYS_IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.klenny',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.tox',
  'target'
]
const IGNORE_DIR_SET = new Set(ALWAYS_IGNORE_DIRS)
const ALWAYS_IGNORE_GLOBS = ALWAYS_IGNORE_DIRS.map((d) => `**/${d}/**`)

/** File-name patterns that are never indexed: logs (often huge and rewritten constantly, which
 *  made them the hottest watcher events) and minified or source-map build artifacts. */
const IGNORED_FILE_PATTERNS = [/\.log$/i, /\.map$/i, /\.min\.(js|css)$/i]

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

function normalize(relPath: string): string {
  return relPath.split('\\').join('/').replace(/^\.\//, '')
}

/**
 * True if any DIRECTORY segment of `relPath` is an always-ignored dir or a dot-directory.
 * Dot-directories are excluded to match the full scan, which globs with `dot: false`.
 */
export function isInIgnoredDir(relPath: string): boolean {
  const segments = normalize(relPath).split('/')
  segments.pop()
  return segments.some((s) => IGNORE_DIR_SET.has(s) || (s.startsWith('.') && s !== '.' && s !== '..'))
}

/**
 * Static (non-.gitignore) eligibility rules shared by the full scan and the live watcher.
 * Before this existed the watcher only checked root-level prefixes, so events from nested
 * `node_modules`, dot-dirs and log files were indexed even though the full scan skipped them.
 */
export function isIgnoredPath(relPath: string): boolean {
  const normalized = normalize(relPath)
  if (!normalized) return true
  if (isInIgnoredDir(normalized)) return true
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (base.startsWith('.')) return true
  return IGNORED_FILE_PATTERNS.some((re) => re.test(base))
}

export function isGitignoreFile(relPath: string): boolean {
  const normalized = normalize(relPath)
  return normalized === '.gitignore' || normalized.endsWith('/.gitignore')
}

interface GitignoreRule {
  /** Directory containing the .gitignore, relative to root, '' for the root itself. */
  base: string
  ig: Ignore
}

// Cached per root so the watcher's frequent single-file checks don't re-read every .gitignore.
// The watcher invalidates it whenever a .gitignore changes; full scans also start fresh.
const gitignoreCache = new Map<string, Promise<GitignoreRule[]>>()

export function invalidateGitignoreCache(root: string): void {
  gitignoreCache.delete(root)
}

async function readGitignoreRules(root: string): Promise<GitignoreRule[]> {
  let files: string[] = []
  try {
    files = await fg('**/.gitignore', {
      cwd: root,
      dot: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: ALWAYS_IGNORE_GLOBS
    })
  } catch {
    files = []
  }
  const rules: GitignoreRule[] = []
  // Shallowest first, so the root .gitignore is consulted before nested ones.
  files.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  for (const rel of files) {
    if (isInIgnoredDir(rel)) continue
    try {
      const content = await readFile(join(root, rel), 'utf8')
      const slash = rel.lastIndexOf('/')
      rules.push({ base: slash === -1 ? '' : rel.slice(0, slash), ig: ignore().add(content) })
    } catch {
      // unreadable .gitignore — skip it
    }
  }
  return rules
}

function loadGitignores(root: string): Promise<GitignoreRule[]> {
  let cached = gitignoreCache.get(root)
  if (!cached) {
    cached = readGitignoreRules(root)
    gitignoreCache.set(root, cached)
  }
  return cached
}

/**
 * Applies every .gitignore whose directory contains `relPath`, each relative to its own
 * directory, the way git scopes nested .gitignore files. Simplification: a negation (`!pattern`)
 * in a deeper file cannot re-include a path a shallower file ignored.
 */
function isGitignored(rules: GitignoreRule[], relPath: string): boolean {
  for (const { base, ig } of rules) {
    if (base === '') {
      if (ig.ignores(relPath)) return true
    } else if (relPath.startsWith(`${base}/`)) {
      if (ig.ignores(relPath.slice(base.length + 1))) return true
    }
  }
  return false
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
 * Lists workspace files eligible for indexing: the always-ignored dirs (at any depth), dot
 * files/dirs, log and build-artifact patterns, every .gitignore in the tree, plus a binary and
 * oversized-file guard, so embedding budget isn't spent on images, lockfiles or data blobs.
 */
export async function listIndexableFiles(root: string): Promise<string[]> {
  const rules = await loadGitignores(root)
  const candidates = await fg('**/*', {
    cwd: root,
    absolute: false,
    dot: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ALWAYS_IGNORE_GLOBS
  })

  const out: string[] = []
  for (const rel of candidates) {
    if (isIgnoredPath(rel)) continue
    if (isGitignored(rules, rel)) continue
    if (hasBinaryExtension(rel)) continue
    try {
      const st = await stat(join(root, rel))
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
 * Same eligibility rules as `listIndexableFiles`, applied to a single relative path. The live
 * watcher uses it so one file-change event doesn't require re-listing the whole workspace.
 */
export async function isFileIndexable(root: string, relPath: string): Promise<boolean> {
  const normalized = normalize(relPath)
  if (isIgnoredPath(normalized)) return false
  if (hasBinaryExtension(normalized)) return false
  const rules = await loadGitignores(root)
  if (isGitignored(rules, normalized)) return false
  try {
    const st = await stat(join(root, normalized))
    if (!st.isFile()) return false
    if (st.size === 0 || st.size > MAX_FILE_BYTES) return false
    return true
  } catch {
    return false
  }
}
