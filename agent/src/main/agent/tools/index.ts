import { readFile, writeFile, unlink, stat, mkdir } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import fg from 'fast-glob'
import type { ToolName, ToolResultPayload } from '@shared/types'
import { getRgPath } from '../../ripgrep'
import { buildEditNotFoundHelp, countOccurrences, resolveEditMatch } from './edit-match'
import { detectEol, fromLf, toLf } from './eol'
import { makeDiff } from './diff'
import { assertInWorkspace, getWorkspace } from '../../workspace'
import { buildShellInvocation, resolveShell } from '../../shells'

// `content` in this cache is always normalized to LF, regardless of the file's on-disk
// EOL style or the machine's `core.autocrlf` setting — see ./eol.ts. This keeps matching,
// line numbering, and diffing consistent no matter how the file (or model output) is
// line-ended; the original EOL style is restored when writing back to disk.
const fileReadCache = new Map<string, { mtimeMs: number; content: string }>()

export function resolveWorkspacePath(relOrAbs: string): string {
  const ws = getWorkspace()
  if (!ws) throw new Error('No workspace open.')
  return isAbsolute(relOrAbs) ? resolve(relOrAbs) : resolve(ws, relOrAbs)
}

export async function readFileTool(args: { path: string; offset?: number; limit?: number }): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path)
  if (!assertInWorkspace(abs)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const raw = await readFile(abs, 'utf8')
  const content = toLf(raw)
  const st = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st.mtimeMs, content })
  const lines = content.split('\n')
  const offset = Math.max(1, args.offset ?? 1)
  const limit = args.limit ?? lines.length
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const numbered = slice.map((l, i) => `${offset + i}|${l}`).join('\n')
  return { ok: true, summary: `Read ${args.path} (${slice.length} lines)`, data: { path: args.path, content: numbered } }
}

export async function writeFileTool(args: { path: string; content: string }): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path)
  if (!assertInWorkspace(abs)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  let oldRaw = ''
  let hadExisting = false
  try {
    oldRaw = await readFile(abs, 'utf8')
    hadExisting = true
  } catch {
    // new file
  }
  // Preserve the existing file's EOL convention (default to LF for new files) so we don't
  // rewrite an entire CRLF file to LF (or vice versa) just because the model's content
  // string happens to use a different style. Model output is normalized to LF first.
  const eol = hadExisting ? detectEol(oldRaw) : '\n'
  const normalized = toLf(args.content)
  const finalContent = fromLf(normalized, eol)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, finalContent, 'utf8')
  const st = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st.mtimeMs, content: normalized })
  return {
    ok: true,
    summary: `Wrote ${args.path}`,
    data: { path: args.path, diff: makeDiff(toLf(oldRaw), normalized, args.path) }
  }
}

export async function editFileTool(args: {
  path: string
  old_string: string
  new_string: string
  replace_all?: boolean
}): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path)
  if (!assertInWorkspace(abs)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const raw = await readFile(abs, 'utf8')
  const eol = detectEol(raw)
  const content = toLf(raw)
  const cached = fileReadCache.get(abs)
  const st = await stat(abs)
  if (cached && cached.mtimeMs !== st.mtimeMs) {
    return {
      ok: false,
      summary: 'File changed on disk since last read',
      error: 'stale',
      data: { path: args.path, hint: 'Call read_file again, then retry edit_file with the exact text shown.' }
    }
  }

  const match = resolveEditMatch(content, args.old_string, args.new_string)
  if (!match) {
    return {
      ok: false,
      summary: 'old_string not found',
      error: 'not_found',
      data: { path: args.path, ...buildEditNotFoundHelp(content, args.old_string) }
    }
  }

  const count = countOccurrences(content, match.oldString)
  if (!args.replace_all && count > 1) {
    return {
      ok: false,
      summary: `old_string appears ${count} times; use replace_all or provide more context`,
      error: 'ambiguous',
      data: { path: args.path, occurrences: count }
    }
  }
  const next = args.replace_all
    ? content.replaceAll(match.oldString, match.newString)
    : content.replace(match.oldString, match.newString)
  // Write back using the file's original EOL style so we don't churn the whole file's
  // line endings on a small edit (which would happen if we always wrote LF-only, and
  // would produce a noisy diff/unwanted git changes when core.autocrlf converts on checkout).
  await writeFile(abs, fromLf(next, eol), 'utf8')
  const st2 = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st2.mtimeMs, content: next })
  return {
    ok: true,
    summary: args.replace_all ? `Edited ${args.path} (${count} replacements)` : `Edited ${args.path}`,
    data: { path: args.path, diff: makeDiff(content, next, args.path), replacements: count }
  }
}

export async function deleteFileTool(args: { path: string }): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path)
  if (!assertInWorkspace(abs)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  let oldContent = ''
  try {
    oldContent = toLf(await readFile(abs, 'utf8'))
  } catch {
    return { ok: false, summary: 'File not found', error: 'not_found' }
  }
  await unlink(abs)
  fileReadCache.delete(abs)
  return {
    ok: true,
    summary: `Deleted ${args.path}`,
    data: { path: args.path, diff: makeDiff(oldContent, '', args.path) }
  }
}

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
  if (!ws) return { ok: false, summary: 'No workspace', error: 'no_workspace' }
  const searchPath = args.path ? resolveWorkspacePath(args.path) : ws
  if (!assertInWorkspace(searchPath)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }

  const rgArgs = ['--json', '--max-count', '200', '-e', args.pattern, searchPath]
  const context = Math.max(0, Math.min(args.context ?? 0, 10))
  if (context > 0) rgArgs.unshift('-C', String(context))
  if (args.case_insensitive) rgArgs.unshift('-i')
  if (args.glob) rgArgs.unshift('--glob', args.glob)

  try {
    const output = await runProcess(getRgPath(), rgArgs, ws, 30_000, false, signal)
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
          hits.push({
            file: j.data.path.text.replace(ws + '/', '').replace(ws + '\\', ''),
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
  if (!ws) return { ok: false, summary: 'No workspace', error: 'no_workspace' }
  const cwd = args.cwd ? resolveWorkspacePath(args.cwd) : ws
  if (!assertInWorkspace(cwd)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const files = await fg(args.pattern, { cwd, absolute: false, dot: false, ignore: ['**/node_modules/**', '**/.git/**'] })
  return { ok: true, summary: `Found ${files.length} files`, data: { files: files.slice(0, 500) } }
}

/** DuckDuckGo's HTML result links are redirects (`//duckduckgo.com/l/?uddg=<encoded-target>&rut=...`),
 *  not the real target — unwrap the `uddg` param to get the actual URL the model can fetch. */
function decodeDdgRedirect(href: string): string | null {
  try {
    const normalized = href.replace(/&amp;/g, '&')
    const withProtocol = normalized.startsWith('//') ? `https:${normalized}` : normalized
    const parsed = new URL(withProtocol)
    return parsed.searchParams.get('uddg') || withProtocol
  } catch {
    return null
  }
}

function decodeHtmlEntities(text: string): string {
  return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

export async function webSearchTool(args: { query: string }): Promise<ToolResultPayload> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'KlennyCode/0.1' } })
  const html = await res.text()
  const results: Array<{ title: string; url: string }> = []
  // Match the whole <a ... class="result__a" ...>Title</a> tag so href can be pulled out
  // regardless of attribute order (href appears before class in DuckDuckGo's markup).
  const anchorRe = /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/g
  let m: RegExpExecArray | null
  while ((m = anchorRe.exec(html)) && results.length < 8) {
    const hrefMatch = m[0].match(/href="([^"]*)"/)
    const targetUrl = hrefMatch && decodeDdgRedirect(hrefMatch[1])
    if (!targetUrl) continue
    const title = decodeHtmlEntities(m[1].replace(/<[^>]+>/g, '')).trim()
    results.push({ title, url: targetUrl })
  }
  return { ok: true, summary: `Search: ${args.query}`, data: { query: args.query, results } }
}

export async function fetchUrlTool(args: { url: string }): Promise<ToolResultPayload> {
  const res = await fetch(args.url, { headers: { 'User-Agent': 'KlennyCode/0.1' } })
  const contentType = res.headers.get('content-type') ?? ''
  if (!res.ok) {
    return {
      ok: false,
      summary: `Fetch failed: HTTP ${res.status}`,
      error: 'http_error',
      data: { url: args.url, status: res.status }
    }
  }
  if (!/text|html|json|xml/i.test(contentType)) {
    return {
      ok: false,
      summary: `Fetch failed: unsupported content-type "${contentType || 'unknown'}"`,
      error: 'unsupported_content_type',
      data: { url: args.url, contentType }
    }
  }
  const text = await res.text()
  const stripped = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  return { ok: true, summary: `Fetched ${args.url}`, data: { url: args.url, content: stripped.slice(0, 12_000) } }
}

const backgroundProcs = new Map<string, { pid: number; command: string }>()

export async function runCommandTool(
  args: {
    command: string
    cwd?: string
    timeout_ms?: number
  },
  signal?: AbortSignal,
  shellId?: string | null
): Promise<ToolResultPayload> {
  const ws = getWorkspace()
  if (!ws) return { ok: false, summary: 'No workspace', error: 'no_workspace' }
  if (looksLikeFileEditCommand(args.command)) {
    return {
      ok: false,
      summary: 'Use edit_file or write_file to change files — not shell commands',
      error: 'use_native_edit_tools',
      data: {
        hint: 'read_file the target, then edit_file with old_string/new_string (set replace_all: true for renames)'
      }
    }
  }
  const cwd = args.cwd ? resolveWorkspacePath(args.cwd) : ws
  if (!assertInWorkspace(cwd)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const timeout = args.timeout_ms ?? 30_000
  const shell = resolveShell(shellId)
  const { cmd, args: shellArgs } = buildShellInvocation(shell, args.command)

  const result = await runProcess(cmd, shellArgs, cwd, timeout, true, signal)
  if (result.timedOut) {
    if (result.pid) {
      backgroundProcs.set(String(result.pid), { pid: result.pid, command: args.command })
      return {
        ok: true,
        summary: `Command moved to background (pid ${result.pid})`,
        data: { command: args.command, background: true, pid: result.pid, partialStdout: result.stdout, partialStderr: result.stderr }
      }
    }
    return { ok: false, summary: 'Command timed out', error: 'timeout', data: result }
  }
  return {
    ok: result.exitCode === 0,
    summary: `Exit ${result.exitCode}`,
    data: { command: args.command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
  }
}

export function killBackgroundProcess(pid: number): boolean {
  try {
    process.kill(pid)
    backgroundProcs.delete(String(pid))
    return true
  } catch {
    return false
  }
}

function looksLikeFileEditCommand(command: string): boolean {
  const patterns = [
    /writefilesync|\.writefile\s*\(/i,
    /createwritestream/i,
    /\bsed\s+[^\n|]*-i/,
    /\bperl\s+-pi/,
    /\becho\s+[^\n|]*>>?/,
    /\btee\s+/,
    /\bnode\s+[^\n]*(-e|--eval)[^\n]*(writefilesync|writefile|createwritestream)/i,
    /\bpython\s+[^\n]*(-c|--command)[^\n]*\bopen\s*\(/i,
    /\bpowershell\b[^\n]*(set-content|out-file|add-content)/i,
    /\b(ex|ed)\s+[^\n]*<<</
  ]
  return patterns.some((p) => p.test(command))
}

function runProcess(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  allowBackground = false,
  signal?: AbortSignal
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; pid?: number }> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ stdout: '', stderr: 'Aborted', exitCode: 1, timedOut: false })
      return
    }

    const child = spawn(cmd, args, { cwd, shell: false })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const finish = (result: { stdout: string; stderr: string; exitCode: number; timedOut: boolean; pid?: number }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const onAbort = () => {
      timedOut = false
      try {
        child.kill()
      } catch {
        // ignore
      }
      finish({ stdout, stderr, exitCode: 1, timedOut: false })
    }
    signal?.addEventListener('abort', onAbort)

    const timer = setTimeout(() => {
      timedOut = true
      if (allowBackground) {
        finish({ stdout, stderr, exitCode: -1, timedOut: true, pid: child.pid })
        return
      }
      child.kill()
    }, timeoutMs)

    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) => {
      finish({ stdout, stderr: `${stderr}${err.message}`, exitCode: 1, timedOut: false })
    })
    child.on('close', (code) => {
      if (!timedOut || !allowBackground) {
        finish({ stdout, stderr, exitCode: code ?? 1, timedOut })
      }
    })
  })
}

// Re-exported for backward compatibility — canonical definitions now live in @shared/types
// (dependency-free, safe to import from test code without pulling in Electron).
export { READ_ONLY_TOOLS, MUTATING_TOOLS } from '@shared/types'
