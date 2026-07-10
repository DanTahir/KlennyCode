import { readFile, writeFile, unlink, stat, mkdir } from 'node:fs/promises'
import { dirname, resolve, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import fg from 'fast-glob'
import type { ToolName, ToolResultPayload } from '@shared/types'
import { getRgPath } from '../../ripgrep'
import { buildEditNotFoundHelp, countOccurrences, resolveEditMatch } from './edit-match'
import { assertInWorkspace, getWorkspace } from '../../workspace'

const fileReadCache = new Map<string, { mtimeMs: number; content: string }>()

export function resolveWorkspacePath(relOrAbs: string): string {
  const ws = getWorkspace()
  if (!ws) throw new Error('No workspace open.')
  return isAbsolute(relOrAbs) ? resolve(relOrAbs) : resolve(ws, relOrAbs)
}

export async function readFileTool(args: { path: string; offset?: number; limit?: number }): Promise<ToolResultPayload> {
  const abs = resolveWorkspacePath(args.path)
  if (!assertInWorkspace(abs)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }
  const content = await readFile(abs, 'utf8')
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
  let oldContent = ''
  try {
    oldContent = await readFile(abs, 'utf8')
  } catch {
    // new file
  }
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, args.content, 'utf8')
  const st = await stat(abs)
  fileReadCache.set(abs, { mtimeMs: st.mtimeMs, content: args.content })
  return {
    ok: true,
    summary: `Wrote ${args.path}`,
    data: { path: args.path, diff: makeDiff(oldContent, args.content, args.path) }
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
  const content = await readFile(abs, 'utf8')
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
  await writeFile(abs, next, 'utf8')
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
    oldContent = await readFile(abs, 'utf8')
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
  },
  signal?: AbortSignal
): Promise<ToolResultPayload> {
  const ws = getWorkspace()
  if (!ws) return { ok: false, summary: 'No workspace', error: 'no_workspace' }
  const searchPath = args.path ? resolveWorkspacePath(args.path) : ws
  if (!assertInWorkspace(searchPath)) return { ok: false, summary: 'Path outside workspace', error: 'sandbox' }

  const rgArgs = ['--json', '--max-count', '200', '-e', args.pattern, searchPath]
  if (args.case_insensitive) rgArgs.unshift('-i')
  if (args.glob) rgArgs.unshift('--glob', args.glob)

  try {
    const output = await runProcess(getRgPath(), rgArgs, ws, 30_000, false, signal)
    const hits: Array<{ file: string; line: number; text: string }> = []
    for (const line of output.stdout.split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line) as { type: string; data?: { path?: { text: string }; line_number?: number; lines?: { text: string } } }
        if (j.type === 'match' && j.data?.path?.text) {
          hits.push({
            file: j.data.path.text.replace(ws + '/', '').replace(ws + '\\', ''),
            line: j.data.line_number ?? 0,
            text: (j.data.lines?.text ?? '').trimEnd()
          })
        }
      } catch {
        // ignore
      }
    }
    return { ok: true, summary: `Found ${hits.length} matches`, data: { hits } }
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

export async function webSearchTool(args: { query: string }): Promise<ToolResultPayload> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'KlennyCode/0.1' } })
  const html = await res.text()
  const snippets = [...html.matchAll(/class="result__a"[^>]*>([^<]+)</g)].slice(0, 8).map((m) => m[1])
  return { ok: true, summary: `Search: ${args.query}`, data: { query: args.query, snippets } }
}

export async function fetchUrlTool(args: { url: string }): Promise<ToolResultPayload> {
  const res = await fetch(args.url, { headers: { 'User-Agent': 'KlennyCode/0.1' } })
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
  signal?: AbortSignal
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
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', args.command] : ['-c', args.command]

  const result = await runProcess(shell, shellArgs, cwd, timeout, true, signal)
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

function makeDiff(oldText: string, newText: string, path: string): string {
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  const max = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < max; i++) {
    const o = oldLines[i]
    const n = newLines[i]
    if (o === n) continue
    if (o !== undefined) out.push(`-${o}`)
    if (n !== undefined) out.push(`+${n}`)
  }
  return out.join('\n')
}

export const READ_ONLY_TOOLS: ToolName[] = [
  'read_file',
  'grep',
  'glob',
  'web_search',
  'fetch_url',
  'list_skills',
  'read_skill',
  'ask_question'
]

export const MUTATING_TOOLS: ToolName[] = ['write_file', 'edit_file', 'delete_file', 'run_command', 'write_memory', 'task']
