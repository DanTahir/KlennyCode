import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getWorkspace } from './workspace'

/**
 * Cross-project discovery: finds every project Klenny has ever generated per-project data
 * for (memory notes, plans, codebase index — see `dataDir.ts`) or opened a chat session in
 * (see `session/store.ts`), so the agent can read files/memory from OTHER projects on request
 * (read-only — see `agent/tools/otherProjects.ts`). Both directories key entries by a
 * base64url encoding of the absolute workspace path, so this just decodes and dedupes them.
 *
 * There is no separate "recent projects" list in settings — this enumeration doubles as one.
 */

function decodeId(id: string): string | null {
  try {
    const decoded = Buffer.from(id, 'base64url').toString('utf8')
    return decoded || null
  } catch {
    return null
  }
}

function stripKnownSuffix(name: string): string {
  if (name.endsWith('.history.json')) return name.slice(0, -'.history.json'.length)
  if (name.endsWith('.json')) return name.slice(0, -'.json'.length)
  return name
}

async function listDirIds(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.map((e) => stripKnownSuffix(e.name))
  } catch {
    return []
  }
}

/** Every known project path (excluding the currently open workspace), deduped and sorted. */
export async function listKnownProjects(): Promise<string[]> {
  const userData = app.getPath('userData')
  const [projectIds, sessionIds] = await Promise.all([
    listDirIds(join(userData, 'projects')),
    listDirIds(join(userData, 'sessions'))
  ])

  const current = getWorkspace()
  const currentNorm = current ? normalizePath(current) : null

  const seen = new Set<string>()
  const result: string[] = []
  for (const id of [...projectIds, ...sessionIds]) {
    const path = decodeId(id)
    if (!path) continue
    const norm = normalizePath(path)
    if (currentNorm && norm === currentNorm) continue
    if (seen.has(norm)) continue
    if (!existsSync(path)) continue
    seen.add(norm)
    result.push(path)
  }
  return result.sort((a, b) => a.localeCompare(b))
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
}

/**
 * Resolves a model-supplied project reference (an absolute path, or just a folder name) to
 * a known project's exact stored path. Returns null if it doesn't match any known project —
 * callers should reject rather than falling back to an arbitrary filesystem path, so
 * cross-project tools can only ever reach projects Klenny has actually seen before.
 */
export async function resolveKnownProject(ref: string): Promise<string | null> {
  const known = await listKnownProjects()
  const refNorm = normalizePath(ref)
  const exact = known.find((p) => normalizePath(p) === refNorm)
  if (exact) return exact
  const byBasename = known.filter((p) => normalizePath(p).split('/').pop() === refNorm.split('/').pop())
  if (byBasename.length === 1) return byBasename[0]
  return null
}

export function isPathInsideRoot(absPath: string, root: string): boolean {
  const normalized = normalizePath(absPath)
  const normRoot = normalizePath(root)
  return normalized === normRoot || normalized.startsWith(normRoot + '/')
}
