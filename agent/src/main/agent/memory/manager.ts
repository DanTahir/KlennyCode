import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getWorkspace } from '../../workspace'
import { globalKlennyDir, projectDataDir } from '../../dataDir'

const GLOBAL_DIR = globalKlennyDir()

/**
 * Auto-memory notes for the current project live under `<userData>/projects/<id>/memory` —
 * NOT inside the project tree — so users never need to .gitignore anything for them.
 */
function projectMemoryDir(ws: string): string {
  return join(projectDataDir(ws), 'memory')
}

export async function loadProjectMemory(workspace?: string): Promise<string> {
  const ws = workspace ?? getWorkspace()
  if (!ws) return ''
  const parts: string[] = []
  for (const name of ['KLENNY.md', 'KLENNY.local.md', join('.klenny', 'KLENNY.md')]) {
    try {
      parts.push(await readFile(join(ws, name), 'utf8'))
    } catch {
      // skip
    }
  }
  return parts.join('\n\n')
}

export async function loadGlobalMemory(): Promise<string> {
  try {
    return await readFile(join(GLOBAL_DIR, 'KLENNY.md'), 'utf8')
  } catch {
    return ''
  }
}

export async function loadAutoMemoryIndex(workspace?: string): Promise<string> {
  const ws = workspace ?? getWorkspace()
  if (!ws) return ''
  const memDir = projectMemoryDir(ws)
  try {
    const raw = await readFile(join(memDir, 'MEMORY.md'), 'utf8')
    const lines = raw.split('\n')
    return lines.slice(0, 200).join('\n')
  } catch {
    return ''
  }
}

/** Memory topics become a literal filename (`<topic>.md`) on disk. Rather than rejecting a
 *  topic containing path separators or other filesystem-illegal characters (the model has
 *  repeatedly ignored the system-prompt instruction not to include them), sanitize it
 *  automatically so the write always succeeds with a safe, close-to-intended filename:
 *  - path separators and other reserved characters (Windows + POSIX) are stripped/replaced
 *  - leading/trailing dots and whitespace (which can create hidden or invalid names) are trimmed
 *  - collapses to a fallback name if nothing usable survives
 *  - truncated to a sane length to avoid hitting filesystem path limits
 */
function sanitizeTopic(topic: string): string {
  if (typeof topic !== 'string' || topic.length === 0) {
    throw new Error('write_memory: topic must be a non-empty string')
  }
  let safe = topic
    // Path separators (the biggest offender) and Windows-reserved characters.
    .replace(/[/\\:*?"<>|]/g, ' ')
    // Control characters, which are also illegal in filenames on most platforms.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    // Collapse any whitespace runs left behind by the replacements above.
    .replace(/\s+/g, ' ')
    .trim()
    // Leading/trailing dots can produce hidden files or "." / ".." on some filesystems.
    .replace(/^\.+|\.+$/g, '')
    .trim()
  if (safe.length === 0) {
    safe = 'Untitled memory'
  }
  // Keep well under typical filesystem filename limits (topic + ".md").
  if (safe.length > 150) {
    safe = safe.slice(0, 150).trim()
  }
  return safe
}

export async function writeMemory(scope: 'project' | 'global', topic: string, content: string): Promise<string> {
  const safeTopic = sanitizeTopic(topic)
  if (scope === 'global') {
    await mkdir(GLOBAL_DIR, { recursive: true })
    const path = join(GLOBAL_DIR, 'memory', `${safeTopic}.md`)
    await mkdir(join(GLOBAL_DIR, 'memory'), { recursive: true })
    await writeFile(path, content, 'utf8')
    await updateMemoryIndex(join(GLOBAL_DIR, 'memory'), safeTopic, content.split('\n')[0] ?? safeTopic)
    return safeTopic
  }
  const ws = getWorkspace()
  if (!ws) throw new Error('No workspace open')
  const memDir = projectMemoryDir(ws)
  await mkdir(memDir, { recursive: true })
  const path = join(memDir, `${safeTopic}.md`)
  await writeFile(path, content, 'utf8')
  await updateMemoryIndex(memDir, safeTopic, content.split('\n')[0] ?? safeTopic)
  return safeTopic
}

async function updateMemoryIndex(memDir: string, topic: string, summary: string): Promise<void> {
  const indexPath = join(memDir, 'MEMORY.md')
  let existing = '# Memory Index\n\n'
  try {
    existing = await readFile(indexPath, 'utf8')
  } catch {
    // new
  }
  const line = `- [${topic}](${topic}.md) — ${summary.slice(0, 120)}`
  if (!existing.includes(`[${topic}]`)) {
    await writeFile(indexPath, `${existing.trim()}\n${line}\n`, 'utf8')
  }
}

/**
 * Read/write pair used by the Memory settings panel editor. These must read and write the
 * exact same single file — the canonical, user-editable `KLENNY.md` for the given scope —
 * with nothing else mixed in.
 *
 * Previously `readMemoryFile` concatenated the canonical file with other read-only sources
 * (the auto-memory `MEMORY.md` index, and for project scope also `KLENNY.local.md` /
 * `.klenny/KLENNY.md`) to build a "full picture" view, while `writeMemoryFile` only ever wrote
 * back to the single canonical file. That asymmetry meant: open the panel -> see canonical +
 * auto-notes blended together -> edit -> Save (writes only to canonical file) -> the editor's
 * "reload after save" step re-blends the *unchanged* auto-notes back in, making it look like
 * the save was silently reverted. Auto-memory notes are system-managed (written via
 * `write_memory`/agent tools) and aren't meant to be hand-edited here, so they're intentionally
 * left out of this editor entirely.
 */
export async function readMemoryFile(scope: 'project' | 'global'): Promise<string> {
  if (scope === 'global') return loadGlobalMemory()
  const ws = getWorkspace()
  if (!ws) return ''
  try {
    return await readFile(join(ws, 'KLENNY.md'), 'utf8')
  } catch {
    return ''
  }
}

export async function writeMemoryFile(scope: 'project' | 'global', content: string): Promise<void> {
  if (scope === 'global') {
    await mkdir(GLOBAL_DIR, { recursive: true })
    await writeFile(join(GLOBAL_DIR, 'KLENNY.md'), content, 'utf8')
    return
  }
  const ws = getWorkspace()
  if (!ws) throw new Error('No workspace open')
  await writeFile(join(ws, 'KLENNY.md'), content, 'utf8')
}

/**
 * Read a single auto-memory topic note by name (as listed in the "Auto-memory index"
 * shown in the system prompt, e.g. `[Shell selection feature](Shell selection feature.md)`).
 * These notes live under `<userData>/projects/<id>/memory/` (project) or `~/.klenny/memory/`
 * (global) — NOT in the workspace tree — so they are not reachable via read_file.
 */
export async function readMemoryTopic(scope: 'project' | 'global', topic: string, workspace?: string): Promise<string> {
  const dir =
    scope === 'global'
      ? join(GLOBAL_DIR, 'memory')
      : (() => {
          const ws = workspace ?? getWorkspace()
          if (!ws) throw new Error('No workspace open')
          return projectMemoryDir(ws)
        })()
  const safeTopic = sanitizeTopic(topic.replace(/\.md$/i, ''))
  return readFile(join(dir, `${safeTopic}.md`), 'utf8')
}

export async function listMemoryTopics(scope: 'project' | 'global', workspace?: string): Promise<string[]> {
  const ws = workspace ?? getWorkspace()
  const dir = scope === 'global' ? join(GLOBAL_DIR, 'memory') : ws ? projectMemoryDir(ws) : null
  if (!dir) return []
  try {
    const entries = await readdir(dir)
    return entries.filter((e) => e.endsWith('.md') && e !== 'MEMORY.md').map((e) => e.replace(/\.md$/, ''))
  } catch {
    return []
  }
}
