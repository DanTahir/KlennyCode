import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import matter from 'gray-matter'
import { getWorkspace } from '../../workspace'

const GLOBAL_DIR = join(homedir(), '.klenny')

export function globalKlennyDir(): string {
  return GLOBAL_DIR
}

export async function loadProjectMemory(): Promise<string> {
  const ws = getWorkspace()
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

export async function loadAutoMemoryIndex(): Promise<string> {
  const ws = getWorkspace()
  if (!ws) return ''
  const memDir = join(ws, '.klenny', 'memory')
  try {
    const raw = await readFile(join(memDir, 'MEMORY.md'), 'utf8')
    const lines = raw.split('\n')
    return lines.slice(0, 200).join('\n')
  } catch {
    return ''
  }
}

export async function writeMemory(scope: 'project' | 'global', topic: string, content: string): Promise<void> {
  if (scope === 'global') {
    await mkdir(GLOBAL_DIR, { recursive: true })
    const path = join(GLOBAL_DIR, 'memory', `${topic}.md`)
    await mkdir(join(GLOBAL_DIR, 'memory'), { recursive: true })
    await writeFile(path, content, 'utf8')
    await updateMemoryIndex(join(GLOBAL_DIR, 'memory'), topic, content.split('\n')[0] ?? topic)
    return
  }
  const ws = getWorkspace()
  if (!ws) throw new Error('No workspace open')
  const memDir = join(ws, '.klenny', 'memory')
  await mkdir(memDir, { recursive: true })
  const path = join(memDir, `${topic}.md`)
  await writeFile(path, content, 'utf8')
  await updateMemoryIndex(memDir, topic, content.split('\n')[0] ?? topic)
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

export async function readMemoryFile(scope: 'project' | 'global'): Promise<string> {
  if (scope === 'global') {
    const global = await loadGlobalMemory()
    const autoDir = join(GLOBAL_DIR, 'memory')
    let auto = ''
    try {
      auto = await readFile(join(autoDir, 'MEMORY.md'), 'utf8')
    } catch {
      // none
    }
    return [global, auto].filter(Boolean).join('\n\n')
  }
  const project = await loadProjectMemory()
  const auto = await loadAutoMemoryIndex()
  return [project, auto].filter(Boolean).join('\n\n')
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
 * These notes live under `.klenny/memory/` (project) or `~/.klenny/memory/` (global) —
 * NOT in the workspace tree — so they are not reachable via read_file.
 */
export async function readMemoryTopic(scope: 'project' | 'global', topic: string): Promise<string> {
  const dir =
    scope === 'global'
      ? join(GLOBAL_DIR, 'memory')
      : (() => {
          const ws = getWorkspace()
          if (!ws) throw new Error('No workspace open')
          return join(ws, '.klenny', 'memory')
        })()
  const safeTopic = topic.replace(/\.md$/i, '')
  return readFile(join(dir, `${safeTopic}.md`), 'utf8')
}

export async function listMemoryTopics(scope: 'project' | 'global'): Promise<string[]> {
  const dir =
    scope === 'global'
      ? join(GLOBAL_DIR, 'memory')
      : getWorkspace()
        ? join(getWorkspace()!, '.klenny', 'memory')
        : null
  if (!dir) return []
  try {
    const entries = await readdir(dir)
    return entries.filter((e) => e.endsWith('.md') && e !== 'MEMORY.md').map((e) => e.replace(/\.md$/, ''))
  } catch {
    return []
  }
}
