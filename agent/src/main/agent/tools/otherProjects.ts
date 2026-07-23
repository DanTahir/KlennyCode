import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import fg from 'fast-glob'
import type { ToolResultPayload } from '@shared/types'
import { getRgPath } from '../../ripgrep'
import { runProcess } from './index'
import { toLf } from './eol'
import { listKnownProjects, resolveKnownProject, isPathInsideRoot } from '../../projectsRegistry'
import { loadProjectMemory, loadAutoMemoryIndex, readMemoryTopic, listMemoryTopics } from '../memory/manager'

/**
 * Read-only cross-project tools. These let the agent look at OTHER projects Klenny has
 * previously opened (see projectsRegistry.ts for how "known" is determined) — their files
 * and their memory notes — while working in the current workspace. There is deliberately no
 * write/edit/delete equivalent: these tools exist so the model can reference or port ideas
 * from another project, never to modify one it isn't currently open in.
 *
 * A project reference must resolve to a known project (exact path or unambiguous folder
 * name) — arbitrary filesystem paths outside any known project are rejected, so this can't
 * become a general escape hatch around the current workspace sandbox.
 */

async function resolveProjectOrError(project: string): Promise<{ root: string } | { error: ToolResultPayload }> {
  const root = await resolveKnownProject(project)
  if (!root) {
    const known = await listKnownProjects()
    return {
      error: {
        ok: false,
        summary: `Unknown project "${project}"`,
        error: 'unknown_project',
        data: { knownProjects: known }
      }
    }
  }
  return { root }
}

export async function listProjectsTool(): Promise<ToolResultPayload> {
  const projects = await listKnownProjects()
  return { ok: true, summary: `${projects.length} other known project(s)`, data: { projects } }
}

export async function readOtherProjectFileTool(args: {
  project: string
  path: string
  offset?: number
  limit?: number
}): Promise<ToolResultPayload> {
  const resolved = await resolveProjectOrError(args.project)
  if ('error' in resolved) return resolved.error
  const abs = isAbsolute(args.path) ? resolve(args.path) : resolve(resolved.root, args.path)
  if (!isPathInsideRoot(abs, resolved.root)) {
    return { ok: false, summary: 'Path outside that project', error: 'sandbox' }
  }
  try {
    const raw = await readFile(abs, 'utf8')
    const content = toLf(raw)
    const lines = content.split('\n')
    const offset = Math.max(1, args.offset ?? 1)
    const limit = args.limit ?? lines.length
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((l, i) => `${offset + i}|${l}`).join('\n')
    return {
      ok: true,
      summary: `Read ${args.path} from ${resolved.root} (${slice.length} lines)`,
      data: { project: resolved.root, path: args.path, content: numbered }
    }
  } catch (e) {
    return { ok: false, summary: 'File not found', error: e instanceof Error ? e.message : String(e) }
  }
}

export async function globOtherProjectTool(args: { project: string; pattern: string; cwd?: string }): Promise<ToolResultPayload> {
  const resolved = await resolveProjectOrError(args.project)
  if ('error' in resolved) return resolved.error
  const cwd = args.cwd ? (isAbsolute(args.cwd) ? resolve(args.cwd) : resolve(resolved.root, args.cwd)) : resolved.root
  if (!isPathInsideRoot(cwd, resolved.root)) {
    return { ok: false, summary: 'Path outside that project', error: 'sandbox' }
  }
  const files = await fg(args.pattern, { cwd, absolute: false, dot: false, ignore: ['**/node_modules/**', '**/.git/**'] })
  return { ok: true, summary: `Found ${files.length} files in ${resolved.root}`, data: { project: resolved.root, files: files.slice(0, 500) } }
}

export async function grepOtherProjectTool(args: {
  project: string
  pattern: string
  path?: string
  glob?: string
  case_insensitive?: boolean
  context?: number
}): Promise<ToolResultPayload> {
  const resolved = await resolveProjectOrError(args.project)
  if ('error' in resolved) return resolved.error
  const searchPath = args.path ? (isAbsolute(args.path) ? resolve(args.path) : resolve(resolved.root, args.path)) : resolved.root
  if (!isPathInsideRoot(searchPath, resolved.root)) {
    return { ok: false, summary: 'Path outside that project', error: 'sandbox' }
  }

  const rgArgs = ['--json', '--max-count', '200', '-e', args.pattern, searchPath]
  const context = Math.max(0, Math.min(args.context ?? 0, 10))
  if (context > 0) rgArgs.unshift('-C', String(context))
  if (args.case_insensitive) rgArgs.unshift('-i')
  if (args.glob) rgArgs.unshift('--glob', args.glob)

  try {
    const output = await runProcess(getRgPath(), rgArgs, resolved.root, 30_000, false)
    const hits: Array<{ file: string; line: number; text: string; match: boolean }> = []
    for (const line of output.stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line) as {
          type: string
          data?: { path?: { text: string }; line_number?: number; lines?: { text: string } }
        }
        if ((j.type === 'match' || j.type === 'context') && j.data?.path?.text) {
          hits.push({
            file: j.data.path.text.replace(resolved.root + '/', '').replace(resolved.root + '\\', ''),
            line: j.data.line_number ?? 0,
            text: (j.data.lines?.text ?? '').trimEnd(),
            match: j.type === 'match'
          })
        }
      } catch {
        // ignore malformed line
      }
    }
    const matchCount = hits.filter((h) => h.match).length
    return { ok: true, summary: `Found ${matchCount} matches in ${resolved.root}`, data: { project: resolved.root, hits } }
  } catch (err) {
    return { ok: false, summary: 'grep failed', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function readOtherProjectMemoryTool(args: {
  project: string
  scope: 'project' | 'global'
  topic?: string
}): Promise<ToolResultPayload> {
  // 'global' memory is the same everywhere — no other-project resolution needed, and
  // read_memory already covers it. Cross-project scope only makes sense for 'project'.
  if (args.scope === 'global') {
    return { ok: false, summary: "Use read_memory for scope 'global' — it is not project-specific", error: 'use_read_memory' }
  }
  const resolved = await resolveProjectOrError(args.project)
  if ('error' in resolved) return resolved.error

  if (args.topic) {
    try {
      const content = await readMemoryTopic('project', args.topic, resolved.root)
      return { ok: true, summary: `Read memory topic "${args.topic}" from ${resolved.root}`, data: { project: resolved.root, content } }
    } catch (e) {
      return {
        ok: false,
        summary: `Memory topic "${args.topic}" not found in ${resolved.root}`,
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  const [klennyMd, autoIndex, topics] = await Promise.all([
    loadProjectMemory(resolved.root),
    loadAutoMemoryIndex(resolved.root),
    listMemoryTopics('project', resolved.root)
  ])
  const content = [klennyMd, autoIndex].filter(Boolean).join('\n\n')
  return {
    ok: true,
    summary: `Memory overview for ${resolved.root} (${topics.length} auto-memory topic(s))`,
    data: { project: resolved.root, content, topics }
  }
}
