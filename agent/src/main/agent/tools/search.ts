import fg from 'fast-glob'
import type { ToolResultPayload } from '@shared/types'
import { getRgPath } from '../../ripgrep'
import { getWorkspace } from '../../workspace'
import { resolveWorkspacePath } from './file-ops'
import { runProcess } from './shell'

// grep/glob are global, read-only search tools (see resolveWorkspacePath in file-ops.ts): an
// absolute `path`/`cwd` searches anywhere on the host, a relative one resolves against the open
// workspace, and with neither given they default to the workspace root when one is open. Only
// when there's no workspace AND no explicit path/cwd do we have nothing to search and error out.
export async function grepTool(
  args: {
    pattern: string
    path?: string
    glob?: string
    case_insensitive?: boolean
    /** Lines of context to include before/after each match (ripgrep -C), capped at 10. */
    context?: number
  },
  signal?: AbortSignal
): Promise<ToolResultPayload> {
  const ws = getWorkspace()
  if (!args.path && !ws) return { ok: false, summary: 'No workspace open — pass an absolute path to search', error: 'no_workspace' }
  const searchPath = args.path ? resolveWorkspacePath(args.path) : (ws as string)

  const rgArgs = ['--json', '--max-count', '200', '-e', args.pattern, searchPath]
  const context = Math.max(0, Math.min(args.context ?? 0, 10))
  if (context > 0) rgArgs.unshift('-C', String(context))
  if (args.case_insensitive) rgArgs.unshift('-i')
  if (args.glob) rgArgs.unshift('--glob', args.glob)

  try {
    const cwd = ws ?? searchPath
    const output = await runProcess(getRgPath(), rgArgs, cwd, 30_000, false, signal)
    // With context > 0, ripgrep's --json stream interleaves "match" lines with "context"
    // lines around them — both carry the same path/line_number/lines shape, so we tag each
    // with `match` to distinguish the actual hit from its surrounding context.
    const hits: Array<{ file: string; line: number; text: string; match: boolean }> = []
    for (const line of output.stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line) as {
          type: string
          data?: { path?: { text: string }; line_number?: number; lines?: { text: string } }
        }
        if ((j.type === 'match' || j.type === 'context') && j.data?.path?.text) {
          const raw = j.data.path.text
          hits.push({
            file: ws ? raw.replace(ws + '/', '').replace(ws + '\\', '') : raw,
            line: j.data.line_number ?? 0,
            text: (j.data.lines?.text ?? '').trimEnd(),
            match: j.type === 'match'
          })
        }
      } catch {
        // ignore
      }
    }
    const matchCount = hits.filter((h) => h.match).length
    return { ok: true, summary: `Found ${matchCount} matches`, data: { hits } }
  } catch (err) {
    return { ok: false, summary: 'grep failed', error: err instanceof Error ? err.message : String(err) }
  }
}

export async function globTool(args: { pattern: string; cwd?: string }): Promise<ToolResultPayload> {
  const ws = getWorkspace()
  if (!args.cwd && !ws) return { ok: false, summary: 'No workspace open — pass an absolute cwd to search', error: 'no_workspace' }
  const cwd = args.cwd ? resolveWorkspacePath(args.cwd) : (ws as string)
  const files = await fg(args.pattern, { cwd, absolute: false, dot: false, ignore: ['**/node_modules/**', '**/.git/**'] })
  return { ok: true, summary: `Found ${files.length} files`, data: { files: files.slice(0, 500) } }
}
