/**
 * node-pty on macOS/Linux launches every shell through a small native `spawn-helper` executable
 * next to its `pty.node`. node-pty 1.1.0's npm tarball ships the macOS prebuilds'
 * `spawn-helper` as mode 0644 (no execute bit), and its postinstall never fixes that. So on a
 * fresh install — dev `bun install` and the packaged app alike — every `pty.spawn()` failed with
 * "posix_spawnp failed" and the terminal panel stayed blank.
 *
 * Two layers fix it: `scripts/after-pack.cjs` chmods the helper in the packaged app at build
 * time, and this module self-heals at runtime before the first spawn. The runtime layer covers
 * dev installs and any build made without the hook. Windows uses ConPTY and has no
 * spawn-helper, so everything here is a no-op there.
 */
import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Maps a path inside `app.asar` to its `app.asar.unpacked` twin (where electron-builder's
 *  asarUnpack puts node-pty's native files), mirroring node-pty's own helperPath rewrite.
 *  Idempotent: an already-unpacked path is returned unchanged. */
export function toUnpackedPath(p: string): string {
  return p.replace(/app\.asar(?!\.unpacked)/, 'app.asar.unpacked')
}

/** Every location node-pty may load spawn-helper from, given its package root. */
export function spawnHelperCandidates(
  ptyRoot: string,
  platform: string = process.platform,
  arch: string = process.arch
): string[] {
  return [
    join(ptyRoot, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
    join(ptyRoot, 'build', 'Release', 'spawn-helper'),
    join(ptyRoot, 'build', 'Debug', 'spawn-helper')
  ]
}

export interface EnsureExecutableResult {
  fixed: string[]
  failed: Array<{ path: string; error: string }>
}

/** For each existing path that isn't executable, adds the execute bits (u+x,g+x,o+x). Missing
 *  paths and already-executable paths are skipped. Never throws. */
export function ensureExecutable(paths: string[]): EnsureExecutableResult {
  const result: EnsureExecutableResult = { fixed: [], failed: [] }
  for (const p of paths) {
    if (!existsSync(p)) continue
    try {
      accessSync(p, constants.X_OK)
      continue
    } catch {
      // not executable — fall through and fix it
    }
    try {
      chmodSync(p, (statSync(p).mode & 0o7777) | 0o111)
      result.fixed.push(p)
    } catch (err) {
      result.failed.push({ path: p, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

let verified = false

/** Locates the installed node-pty package and makes sure its spawn-helper is executable. Runs
 *  the filesystem checks once per process (and retries only if a chmod failed). */
export function ensureNodePtySpawnHelperExecutable(): void {
  if (verified || process.platform === 'win32') return
  let ptyRoot: string
  try {
    // node-pty has no `exports` map, so resolving its main entry (lib/index.js) is reliable.
    ptyRoot = toUnpackedPath(dirname(dirname(createRequire(import.meta.url).resolve('node-pty'))))
  } catch (err) {
    console.error('[terminal] could not locate node-pty to verify spawn-helper permissions:', err)
    verified = true
    return
  }
  const { fixed, failed } = ensureExecutable(spawnHelperCandidates(ptyRoot))
  for (const p of fixed) console.log(`[terminal] restored missing execute bit on node-pty spawn-helper: ${p}`)
  for (const f of failed) {
    console.error(
      `[terminal] node-pty spawn-helper is not executable and chmod failed (${f.error}); ` +
        `the terminal panel cannot start shells. Fix manually with: chmod +x "${f.path}"`
    )
  }
  verified = failed.length === 0
}
