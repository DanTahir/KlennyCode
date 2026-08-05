import { existsSync } from 'node:fs'
import { sep } from 'node:path'

/**
 * Shared asar-unpack path helpers. Bug #10 (esbuild's spawned binary) and Bug #11 (esbuild's
 * `alias` option pointing at react/react-dom/nanoid) are the same underlying issue on two
 * different code paths: Electron's asar transparency only auto-redirects a specific, documented
 * subset of fs/require operations (`fs.readFile`, `require()`, `child_process.execFile`) to the
 * sibling `app.asar.unpacked` directory — it does NOT help when a path string computed from
 * inside a packaged `app.asar` is handed to something that reads the filesystem itself outside
 * that redirected set. For Bug #10 that "something" was esbuild's own spawned native-binary OS
 * process (spawn() gets a raw path string, not routed through Electron's patched Node fs at
 * all). For Bug #11 it's esbuild's `alias` option: once esbuild's *binary* actually runs (post
 * Bug #10 fix) as a real separate OS process, ANY path bundler.ts/vettedLibraries.ts hands it via
 * `alias` — computed via `require.resolve()` at module load, e.g. for react/react-dom/nanoid —
 * is read directly by that external process, with no Electron asar patching involved at all.
 * `app.asar` is one opaque archive file from the OS's point of view, so a path like
 * `...\app.asar\node_modules\react\index.js` is simply not a file that exists on disk — hence
 * `Could not resolve "...\node_modules\react\index.js"` from esbuild itself.
 *
 * Fix pattern (same for both bugs): compute the sibling `app.asar.unpacked` path
 * electron-builder's `asarUnpack` always produces (mirroring the exact same relative structure),
 * and use that instead — but only for packages actually listed in package.json's `asarUnpack`.
 * Any package resolved via `require.resolve()` and then handed to esbuild's `alias` option (or
 * otherwise read by an external process) MUST have a corresponding `asarUnpack` glob entry, or
 * this silently falls back to the original (broken-when-packaged) path — see
 * `resolveForExternalProcess`'s doc comment.
 */

const ASAR_MARKER = `${sep}app.asar${sep}`
const ASAR_UNPACKED_MARKER = `${sep}app.asar.unpacked${sep}`

/** Pure string transform, exported for unit testing: swaps the `app.asar` segment of an absolute
 *  path for `app.asar.unpacked`. Returns the input unchanged if it doesn't contain an `app.asar`
 *  segment at all (dev/test mode, or a path outside any asar archive) — this function never
 *  checks whether the result actually exists on disk; see `resolveForExternalProcess` for that. */
export function toUnpackedAsarPath(absPath: string): string {
  if (!absPath.includes(ASAR_MARKER)) return absPath
  return absPath.replace(ASAR_MARKER, ASAR_UNPACKED_MARKER)
}

/**
 * Resolves an absolute path (typically from `require.resolve()`) for handing to something that
 * reads the filesystem itself outside Electron's asar-transparency layer — esbuild's spawned
 * binary process, or a path fed to esbuild's `alias`/`external` options that its own external
 * process will read directly. If `absPath` is inside an `app.asar` archive AND the corresponding
 * `app.asar.unpacked` mirror actually exists on disk (i.e. the owning package has a matching
 * `asarUnpack` glob in package.json), returns that unpacked path. Otherwise returns `absPath`
 * unchanged — this is deliberately a safe no-op fallback, not a thrown error: in dev/test mode
 * nothing is asar-packed at all (so the `includes` check alone already short-circuits), and if
 * some future package is aliased without ever being added to `asarUnpack`, this falls back to
 * today's pre-fix behavior (broken once packaged) rather than a new, different failure mode —
 * the missing `asarUnpack` entry is the actual bug to fix in that case, not something this
 * function should paper over by throwing.
 */
export function resolveForExternalProcess(absPath: string): string {
  const unpacked = toUnpackedAsarPath(absPath)
  return unpacked !== absPath && existsSync(unpacked) ? unpacked : absPath
}
