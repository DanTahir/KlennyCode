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
