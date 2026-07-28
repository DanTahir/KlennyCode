import type { ToolResultPayload } from '@shared/types'
import { listKnownProjects, resolveKnownProject } from '../../projectsRegistry'

/**
 * Cross-project discovery. Now that read_file/grep/glob are global, read-only tools that can
 * reach any absolute path on the host (see file-ops.ts/search.ts), there's no need for
 * dedicated read_other_project_file/grep_other_project/glob_other_project tools — the model can
 * just pass an absolute path straight to read_file/grep/glob. list_projects sticks around as a
 * quick "projects Klenny has worked in before" discovery shortcut, and its `resolveProjectOrError`
 * helper is reused by the read_memory/list_memory tools' optional `project` argument (see
 * loop.ts) so cross-project *memory* lookups still only ever resolve to a project Klenny has
 * actually seen before, never an arbitrary path.
 */

export async function listProjectsTool(): Promise<ToolResultPayload> {
  const projects = await listKnownProjects()
  return { ok: true, summary: `${projects.length} other known project(s)`, data: { projects } }
}

export async function resolveProjectOrError(project: string): Promise<{ root: string } | { error: ToolResultPayload }> {
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
