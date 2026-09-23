/**
 * GUI-launched apps on macOS (Finder, Dock, Spotlight, login items) inherit launchd's minimal
 * environment: PATH is just /usr/bin:/bin:/usr/sbin:/sbin. Everything the user set up in their
 * shell profile (Homebrew's /opt/homebrew/bin, nvm, volta, ~/.local/bin, ...) is missing, so
 * run_command could not find node/npm/bun/brew/git-lfs and the like, and neither could any other
 * process the app spawns. Linux desktop launchers have the same problem for PATH entries that are
 * only added in ~/.bashrc / ~/.zshrc (nvm, pyenv, ...).
 *
 * Fix (same approach as VS Code / the `shell-env` + `fix-path` packages): once at startup, ask
 * the user's own login + interactive shell for its PATH and merge it into process.env.PATH, login
 * entries first. Every spawn path (tools/shell.ts, terminal.ts via sanitizedSpawnEnv(), and
 * shells.ts's findInPath) reads process.env, so they all pick it up.
 *
 * Only PATH is imported, deliberately: pulling the whole login env would also import per-session
 * values (TERM, PWD, SHLVL, prompt vars, ...) that don't belong in a GUI process.
 *
 * Windows: never runs. Windows GUI apps already get the full user + system PATH from the registry.
 */
import { execFile } from 'node:child_process'
import { delimiter } from 'node:path'

export const PATH_MARKER = '__KLENNY_LOGIN_PATH__'
const RESOLVE_TIMEOUT_MS = 5000

/** Returns the text between the first two occurrences of `marker`, trimmed, or null. The markers
 *  isolate the value from anything rc files print (banners, `motd`, oh-my-zsh update notices). */
export function extractMarkedValue(stdout: string, marker: string = PATH_MARKER): string | null {
  const start = stdout.indexOf(marker)
  if (start === -1) return null
  const from = start + marker.length
  const end = stdout.indexOf(marker, from)
  if (end === -1) return null
  const value = stdout.slice(from, end).trim()
  return value.length > 0 ? value : null
}

/** Merges two PATH strings: every entry of `preferred` first (in order), then any entry of
 *  `existing` not already present. Empty entries and duplicates are dropped. */
export function mergePathLists(preferred: string, existing: string, sep: string = delimiter): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [...preferred.split(sep), ...existing.split(sep)]) {
    const entry = raw.trim()
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out.join(sep)
}

/** The shell to ask: the user's login shell ($SHELL) if it's an absolute path, else the platform
 *  default. */
export function loginShellFor(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const shell = env.SHELL
  if (shell && shell.startsWith('/')) return shell
  return platform === 'darwin' ? '/bin/zsh' : '/bin/sh'
}

/** Runs `shell -i -l -c` to print its PATH between markers. Resolves null on any failure
 *  (timeout, unsupported flags such as tcsh's, no output). Never rejects. */
export function resolveLoginShellPath(shell: string, timeoutMs: number = RESOLVE_TIMEOUT_MS): Promise<string | null> {
  // printf + printenv behave the same in sh/bash/zsh/fish. printenv (not "$PATH") matters for
  // fish, where $PATH is a list that would be space-joined.
  const command = `printf '%s' '${PATH_MARKER}'; printenv PATH; printf '%s' '${PATH_MARKER}'`
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-i', '-l', '-c', command],
      {
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          // Keep common rc-file side effects from stalling or hijacking the probe.
          DISABLE_AUTO_UPDATE: 'true', // oh-my-zsh update prompt
          ZSH_TMUX_AUTOSTART: 'false',
          ZSH_TMUX_AUTOSTARTED: 'true'
        }
      },
      (_err, stdout) => {
        // A non-zero exit is common and harmless (an rc file whose last command failed), so the
        // markers, not the exit code, decide whether the output is usable.
        resolve(extractMarkedValue(typeof stdout === 'string' ? stdout : ''))
      }
    )
  })
}

let pending: Promise<void> | null = null

/** Resolves the login shell's PATH once per process and merges it into process.env.PATH.
 *  Safe to call repeatedly (returns the same promise). No-op on Windows. Never rejects. */
export function applyLoginShellPath(): Promise<void> {
  if (pending) return pending
  pending = (async () => {
    if (process.platform === 'win32') return
    const shell = loginShellFor()
    const startedAt = Date.now()
    const loginPath = await resolveLoginShellPath(shell)
    const ms = Date.now() - startedAt
    if (!loginPath) {
      console.warn(`[shell-env] could not read PATH from login shell ${shell} (${ms}ms); keeping the inherited PATH`)
      return
    }
    const before = process.env.PATH ?? ''
    const merged = mergePathLists(loginPath, before)
    process.env.PATH = merged
    const added = merged.split(delimiter).length - before.split(delimiter).filter(Boolean).length
    console.log(`[shell-env] merged PATH from login shell ${shell} (${ms}ms): ${added} entr${added === 1 ? 'y' : 'ies'} added`)
  })().catch((err) => {
    console.error('[shell-env] unexpected error resolving login shell PATH:', err)
  })
  return pending
}
