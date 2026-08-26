import { spawn } from 'node:child_process'
import type { ToolResultPayload } from '@shared/types'
import { assertInWorkspace, getWorkspace } from '../../workspace'
import { buildShellInvocation, resolveShell } from '../../shells'
import { resolveWorkspacePath } from './file-ops'
import { sanitizedSpawnEnv } from '../../shellEnv'

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
  const editGuardReason = fileEditGuardReason(args.command)
  if (editGuardReason) {
    return {
      ok: false,
      summary: 'Use edit_file or write_file to change files — not shell commands',
      error: 'use_native_edit_tools',
      data: {
        matched: editGuardReason,
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

/* ------------------------------------------------------------------------------------------------
 * run_command's "don't edit files via the shell" guard.
 *
 * Purpose: stop the model from bypassing edit_file/write_file (and their diff previews + approval
 * flow) by shelling out, and steer it toward the native edit tools, which are also the only ones
 * that behave reliably on Windows. This is a nudge, not a security boundary.
 *
 * Every pattern used to be tested against the WHOLE command string, which produced false positives
 * on purely read-only commands. A real command that got blocked:
 *
 *     echo "--- ports ---"; netstat -ano | grep LISTENING; ls *.log 2>/dev/null || echo none
 *
 * `/\becho\s+[^\n|]*>>?/` scanned forward from an `echo` and found the `2>` belonging to a
 * *different* segment. The same whole-string matching made `sed -n '1p' f; grep -i x g` look like
 * `sed -i`, and `/\btee\s+/` was unconditional, blocking `npm run build 2>&1 | tee build.log`.
 *
 * Fix: split the command into statements first (quote-aware), judge each statement on its own, and
 * only treat a redirect/`tee` as a file edit when that statement actually authors its own content
 * (echo/printf/heredoc) and aims it at a real file rather than a null sink.
 * --------------------------------------------------------------------------------------------- */

/** Patterns that mean "this writes a file" regardless of surrounding shell plumbing. Tested per
 *  statement. `sed`/`perl` keep a pipe-excluding character class so a later pipeline stage's flag
 *  (`... | grep -i x`) can't be mistaken for the in-place flag. */
const DIRECT_FILE_WRITE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /writefilesync|\.writefile\s*\(/i, reason: 'writeFile/writeFileSync call' },
  { re: /createwritestream/i, reason: 'createWriteStream call' },
  { re: /\bsed\s+[^\n|]*-i/, reason: 'sed -i in-place edit' },
  { re: /\bperl\s+-pi/, reason: 'perl -pi in-place edit' },
  { re: /\bnode\s+[^\n]*(-e|--eval)[^\n]*(writefilesync|writefile|createwritestream)/i, reason: 'node -e file write' },
  { re: /\bpython\s+[^\n]*(-c|--command)[^\n]*\bopen\s*\(/i, reason: 'python -c open() write' },
  { re: /\bpowershell\b[^\n]*(set-content|out-file|add-content)/i, reason: 'PowerShell file-write cmdlet' },
  { re: /\b(ex|ed)\s+[^\n]*<<</, reason: 'ex/ed scripted edit' }
]

/** Commands that synthesise their own content inline — the only ones whose output redirected into a
 *  file counts as "editing a file from the shell". */
const CONTENT_PRODUCERS = new Set(['echo', 'printf'])

/** Redirect targets that discard output instead of producing a file. */
const NULL_SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', 'nul', 'nul:', 'con'])

const HEREDOC_RE = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*|<<</

/** Split on separators that appear outside quotes. Just enough shell fidelity to stop attributing
 *  one segment's redirect to another segment's command. Multi-char separators must be listed before
 *  their single-char prefixes (`&&`/`||` before `|`). Note: bare `&` is deliberately NOT a
 *  separator, so the extremely common `2>&1` stays intact. */
function splitOutsideQuotes(text: string, separators: string[]): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      current += ch
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    const sep = separators.find((s) => text.startsWith(s, i))
    if (sep) {
      parts.push(current)
      current = ''
      i += sep.length - 1
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts.filter((p) => p.trim().length > 0)
}

/** The command name a pipeline stage actually runs: `FOO=bar /bin/echo hi` → `echo`. */
function leadingCommand(stage: string): string {
  let text = stage.trim()
  for (;;) {
    const stripped = text
      .replace(/^[({\s]+/, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '')
    if (stripped === text) break
    text = stripped
  }
  const token = text.split(/[\s<>;&|]/)[0] ?? ''
  return (token.split(/[\\/]/).pop() ?? '').toLowerCase()
}

/** True if this statement redirects *stdout* to something that is a real file. Skips fd
 *  duplications (`2>&1`), non-stdout fds (`2>log` carries no authored content), null sinks, and
 *  any `>` that is inside quotes (`echo "a > b"`). */
function redirectsToRealFile(statement: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i]!
    if (quote) {
      if (ch === quote && statement[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch !== '>') continue

    // An explicit fd other than stdout (`2>`) can't be carrying echo/printf content.
    const fd = /(?:^|[\s;|&(])(\d+)$/.exec(statement.slice(0, i))
    if (fd && fd[1] !== '1') continue

    let j = i + 1
    if (statement[j] === '>') j++ // `>>` appends; same thing for our purposes
    if (statement[j] === '&') continue // `>&1` duplicates an fd, doesn't open a file

    const target = statement.slice(j).trim().split(/[\s|;&]/)[0] ?? ''
    if (!target) continue
    if (NULL_SINKS.has(target.toLowerCase())) continue
    return true
  }
  return false
}

/** True if the statement synthesises content inline (echo/printf anywhere in its pipeline, or a
 *  heredoc/herestring), i.e. content that could be written into a file. */
function authorsInlineContent(statement: string): boolean {
  if (HEREDOC_RE.test(statement)) return true
  return splitOutsideQuotes(statement, ['|']).some((stage) => CONTENT_PRODUCERS.has(leadingCommand(stage)))
}

/** Returns a short human-readable reason when the command looks like it edits a file, else null.
 *  Exported for tests. */
export function fileEditGuardReason(command: string): string | null {
  for (const statement of splitOutsideQuotes(command, ['&&', '||', ';', '\n'])) {
    for (const { re, reason } of DIRECT_FILE_WRITE_PATTERNS) {
      if (re.test(statement)) return reason
    }
    if (!authorsInlineContent(statement)) continue
    if (redirectsToRealFile(statement)) return 'echo/printf/heredoc content redirected into a file'
    if (splitOutsideQuotes(statement, ['|']).some((stage) => leadingCommand(stage) === 'tee')) {
      return 'echo/printf/heredoc content piped into tee'
    }
  }
  return null
}

/** Shared low-level process runner. Also exported for reuse by grepTool (search.ts) and the
 *  cross-project read-only tools (./otherProjects.ts), which invoke ripgrep the same way
 *  without duplicating this timeout/abort/background handling. */
export function runProcess(
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

    const child = spawn(cmd, args, { cwd, shell: false, env: sanitizedSpawnEnv() })
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
