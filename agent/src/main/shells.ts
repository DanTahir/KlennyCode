import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ShellInfo } from '@shared/types'

/** Searches PATH directories for the first matching executable name. */
function findInPath(exeNames: string[]): string | null {
  const dirs = (process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const exe of exeNames) {
      const full = join(dir, exe)
      if (existsSync(full)) return full
    }
  }
  return null
}

function hasWslDistro(wslPath: string): boolean {
  try {
    const out = execFileSync(wslPath, ['-l', '-q'], { timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).toString(
      'utf16le'
    )
    return out.replace(/\u0000/g, '').trim().length > 0
  } catch {
    return false
  }
}

let cached: ShellInfo[] | null = null

/** Detects shells actually present on this machine. Cheap fs.existsSync checks + a PATH scan; cached for the process lifetime. */
export function detectShells(): ShellInfo[] {
  if (cached) return cached

  const shells: ShellInfo[] = []

  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
    if (existsSync(comspec)) {
      shells.push({ id: 'cmd', name: 'Command Prompt (cmd.exe)', path: comspec, kind: 'cmd' })
    }

    const winPs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    const psPath = existsSync(winPs) ? winPs : findInPath(['powershell.exe'])
    if (psPath) shells.push({ id: 'powershell', name: 'PowerShell', path: psPath, kind: 'powershell' })

    const pwshCandidates = ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe']
    const pwshPath = pwshCandidates.find(existsSync) ?? findInPath(['pwsh.exe'])
    if (pwshPath) shells.push({ id: 'pwsh', name: 'PowerShell 7+ (pwsh)', path: pwshPath, kind: 'powershell' })

    const bashCandidates = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe']
    const bashPath = bashCandidates.find(existsSync) ?? findInPath(['bash.exe'])
    if (bashPath) shells.push({ id: 'git-bash', name: 'Git Bash', path: bashPath, kind: 'posix' })

    const wslPath = existsSync('C:\\Windows\\System32\\wsl.exe') ? 'C:\\Windows\\System32\\wsl.exe' : findInPath(['wsl.exe'])
    // wsl.exe exists as a stub even when the Windows Subsystem for Linux feature/distro isn't
    // installed, and running it in that state prints a "not installed" message to stdout instead
    // of failing — so we probe for an actual installed distro before offering it as an option.
    if (wslPath && hasWslDistro(wslPath)) shells.push({ id: 'wsl', name: 'WSL (bash)', path: wslPath, kind: 'wsl' })
  } else {
    const candidates: Array<{ id: string; name: string; paths: string[] }> = [
      { id: 'zsh', name: 'Zsh', paths: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh'] },
      { id: 'bash', name: 'Bash', paths: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'] },
      { id: 'fish', name: 'Fish', paths: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'] },
      { id: 'sh', name: 'sh (POSIX)', paths: ['/bin/sh'] }
    ]
    for (const c of candidates) {
      const found = c.paths.find(existsSync) ?? findInPath([c.id])
      if (found) shells.push({ id: c.id, name: c.name, path: found, kind: 'posix' })
    }

    // Make sure the user's actual login shell ($SHELL) is offered even if it's something
    // exotic we didn't list above (e.g. nushell, tcsh, a custom build).
    const envShell = process.env.SHELL
    if (envShell && existsSync(envShell) && !shells.some((s) => s.path === envShell)) {
      const name = envShell.split('/').pop() || envShell
      shells.unshift({ id: `env-${name}`, name: `${name} (your default shell)`, path: envShell, kind: 'posix' })
    }
  }

  const seen = new Set<string>()
  cached = shells.filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)))
  return cached
}

/** The shell we fall back to when the user hasn't chosen one, or their choice is no longer available. */
export function defaultShellId(shells: ShellInfo[]): string {
  if (process.platform === 'win32') return shells.find((s) => s.id === 'cmd')?.id ?? shells[0]?.id ?? 'cmd'
  return shells.find((s) => s.id === 'bash')?.id ?? shells[0]?.id ?? 'sh'
}

const HARD_FALLBACK: ShellInfo =
  process.platform === 'win32'
    ? { id: 'cmd', name: 'Command Prompt (cmd.exe)', path: process.env.ComSpec || 'cmd.exe', kind: 'cmd' }
    : { id: 'sh', name: 'sh (POSIX)', path: '/bin/sh', kind: 'posix' }

export function resolveShell(shellId: string | null | undefined): ShellInfo {
  const shells = detectShells()
  const found = shellId ? shells.find((s) => s.id === shellId) : undefined
  if (found) return found
  const fallback = shells.find((s) => s.id === defaultShellId(shells))
  return fallback ?? shells[0] ?? HARD_FALLBACK
}

export function buildShellInvocation(shell: ShellInfo, command: string): { cmd: string; args: string[] } {
  switch (shell.kind) {
    case 'cmd':
      return { cmd: shell.path, args: ['/d', '/s', '/c', command] }
    case 'powershell':
      return { cmd: shell.path, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
    case 'wsl':
      return { cmd: shell.path, args: ['-e', 'bash', '-c', command] }
    case 'posix':
    default:
      return { cmd: shell.path, args: ['-c', command] }
  }
}
