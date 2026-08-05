import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

/**
 * Bug #10 fix: esbuild's native binary can't be spawned once the app is packaged.
 *
 * Root cause: Electron's asar transparency only auto-redirects a specific, documented subset of
 * fs/require operations to the sibling `app.asar.unpacked` directory (e.g. `fs.readFile`,
 * `require()`, `child_process.execFile`) — it does NOT redirect a raw path string handed to
 * `child_process.spawn()`. esbuild's own JS API (lib/main.js) resolves its native binary's path
 * via `require.resolve()` and then calls `child_process.spawn(command, ...)` directly with that
 * resolved string. Once packaged, esbuild's own module is loaded from inside `app.asar` (it's a
 * real, non-dev dependency — see package.json), so `require.resolve()` returns an
 * asar-archive-internal virtual path. That path isn't a real file the OS can execute, so `spawn`
 * fails with `ENOENT`, and esbuild's long-lived "service" child process never starts — every
 * subsequent build/transform call then fails trying to write to that already-dead pipe, which is
 * exactly what surfaces to the user as `Error: The service is no longer running: write EPIPE`
 * (or, from the initial spawn attempt itself, `The service was stopped: spawn ... ENOENT`).
 * Confirmed by reproducing this directly: requiring esbuild out of a real packaged
 * `app.asar` (via `ELECTRON_RUN_AS_NODE=1 KlennyCode.exe script.js`) throws exactly this error,
 * even though `esbuild`/`@esbuild/*` are correctly present in `app.asar.unpacked` on disk
 * (package.json's `asarUnpack` list) — the unpack alone isn't sufficient because esbuild's own
 * path computation never looks there.
 *
 * Fix: esbuild honors an `ESBUILD_BINARY_PATH` env var override, read into a module-level
 * variable once at import time (see esbuild/lib/main.js), checked before any of its own path
 * computation. If we detect we're running packaged (esbuild's own resolved path contains
 * `app.asar`), compute the real on-disk unpacked path — electron-builder's `asarUnpack` always
 * mirrors the exact same relative structure into a sibling `app.asar.unpacked` directory — and
 * set the env var to point there instead, before esbuild's own module ever evaluates.
 *
 * Import-order requirement (revised — an EARLIER version of this fix was itself broken by a
 * second, subtler packaging quirk, worth documenting so it isn't reintroduced): the original fix
 * imported this module first, then had bundler.ts/validator.ts statically
 * `import { build/transform } from 'esbuild'` afterward, reasoning that ESM module-evaluation
 * order runs an importing module's full transitive import list before its own top-level code.
 * That reasoning is correct for *separate* modules/files — but electron-vite's Rollup build
 * flattens the entire main process into ONE output chunk, and Rollup hoists a STATIC import of
 * an external (non-bundled) package like 'esbuild' to the very top of that single chunk,
 * evaluated before literally anything else in the whole bundle, regardless of where the
 * corresponding `import` line was written in any source file. So the static
 * `import { build } from 'esbuild'` in bundler.ts still evaluated (and esbuild still captured its
 * own, wrong, asar-internal binary path) before this module's side effect ever ran. Fixed by
 * making bundler.ts/validator.ts import esbuild dynamically (`await import('esbuild')`, inside
 * the function that needs it) instead of statically — a dynamic import is a genuine runtime
 * expression Rollup cannot hoist, so by the time it executes, this module's side effect (a
 * regular *local*, non-externalized module, inlined by Rollup in normal source order) has
 * already run. This module itself still only needs to be imported (for its side effect) at some
 * point before that dynamic `import('esbuild')` call fires at runtime — an ordinary static
 * top-level import of this file in bundler.ts/validator.ts satisfies that, since local-module
 * one evaluates first actually needs to.
 */

const ASAR_MARKER = `${sep}app.asar${sep}`
const ASAR_UNPACKED_MARKER = `${sep}app.asar.unpacked${sep}`

/** Pure path computation, exported for unit testing without needing a real packaged filesystem.
 *  Returns null if `esbuildMainPath` isn't inside an app.asar archive at all (dev/test mode —
 *  nothing to fix, esbuild resolves its own binary just fine). */
export function computeUnpackedEsbuildBinaryPath(esbuildMainPath: string, platform: string, arch: string): string | null {
  if (!esbuildMainPath.includes(ASAR_MARKER)) return null
  const unpackedMainPath = esbuildMainPath.replace(ASAR_MARKER, ASAR_UNPACKED_MARKER)
  // esbuildMainPath resolves to `.../node_modules/esbuild/lib/main.js` — walk up three levels
  // (lib -> esbuild -> node_modules) to find the unpacked node_modules directory.
  const nodeModulesDir = dirname(dirname(dirname(unpackedMainPath)))
  // @esbuild/<platform>-<arch> mirrors process.platform/process.arch directly (e.g.
  // "win32-x64", "darwin-arm64", "linux-x64") — matches esbuild's own knownWindowsPackages/
  // knownUnixlikePackages naming, without needing to duplicate that whole lookup table here.
  const platformDirName = `${platform}-${arch}`
  const pkgDir = join(nodeModulesDir, '@esbuild', platformDirName)
  return platform === 'win32' ? join(pkgDir, 'esbuild.exe') : join(pkgDir, 'bin', 'esbuild')
}

function ensureEsbuildBinaryPathForPackagedApp(): void {
  if (process.env.ESBUILD_BINARY_PATH) return // already explicitly configured — never override
  try {
    const nodeRequire = createRequire(import.meta.url)
    const esbuildMainPath = nodeRequire.resolve('esbuild')
    const candidate = computeUnpackedEsbuildBinaryPath(esbuildMainPath, process.platform, process.arch)
    if (candidate && existsSync(candidate)) {
      process.env.ESBUILD_BINARY_PATH = candidate
    }
  } catch {
    // Defensive: never let a packaging-path quirk throw here — worst case is we simply don't
    // set the override, leaving esbuild's own (already broken-when-packaged) resolution as-is,
    // which is exactly today's pre-fix status quo rather than a new failure mode.
  }
}

// Runs automatically the moment this module is first evaluated — see the import-order doc
// comment above for why this MUST be a top-level side effect, not an exported function.
ensureEsbuildBinaryPathForPackagedApp()
