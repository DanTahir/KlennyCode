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
  const memDir = projectMemoryDir(ws)
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
  const safeTopic = topic.replace(/\.md$/i, '')
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
