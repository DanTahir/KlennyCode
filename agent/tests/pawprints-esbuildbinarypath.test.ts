import { describe, expect, test } from 'bun:test'
import { computeUnpackedEsbuildBinaryPath } from '../src/main/agent/pawprints/esbuildBinaryPath'
import { sep } from 'node:path'

// Regression coverage for Bug #10 ("The service is no longer running: write EPIPE" / "The
// service was stopped: spawn ... ENOENT" only in the packaged app, never in `npm run dev`).
// See esbuildBinaryPath.ts's own doc comment for the full root-cause writeup. This tests only
// the pure path-computation helper — the actual env-var side effect and the dynamic-import
// ordering fix (bundler.ts/validator.ts using `await import('esbuild')` instead of a static
// top-level import, so Rollup can't hoist it above this module's side effect) were verified by
// directly reproducing against a real packaged app.asar (ELECTRON_RUN_AS_NODE=1 + a real
// electron-builder --dir build), not by a unit test — asar/electron-builder packaging behavior
// isn't something bun:test can exercise directly.
describe('computeUnpackedEsbuildBinaryPath', () => {
  test('returns null when the given path is not inside an app.asar archive (dev/test mode — nothing to fix)', () => {
    const devPath = `C:${sep}some${sep}project${sep}node_modules${sep}esbuild${sep}lib${sep}main.js`
    expect(computeUnpackedEsbuildBinaryPath(devPath, 'win32', 'x64')).toBeNull()
  })

  test('computes the win32 unpacked .exe path from an asar-internal esbuild main.js path', () => {
    const asarPath = ['C:', 'app', 'resources', 'app.asar', 'node_modules', 'esbuild', 'lib', 'main.js'].join(sep)
    const result = computeUnpackedEsbuildBinaryPath(asarPath, 'win32', 'x64')
    expect(result).toBe(
      ['C:', 'app', 'resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'].join(sep)
    )
  })

  test('computes the unix bin/esbuild path (no .exe, nested bin/ subdirectory) for a non-Windows platform', () => {
    const asarPath = ['', 'app', 'resources', 'app.asar', 'node_modules', 'esbuild', 'lib', 'main.js'].join(sep)
    const result = computeUnpackedEsbuildBinaryPath(asarPath, 'darwin', 'arm64')
    expect(result).toBe(
      ['', 'app', 'resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'].join(sep)
    )
  })

  test('linux x64 mirrors process.platform/process.arch directly into the @esbuild/<platform>-<arch> package name', () => {
    const asarPath = ['', 'app', 'resources', 'app.asar', 'node_modules', 'esbuild', 'lib', 'main.js'].join(sep)
    const result = computeUnpackedEsbuildBinaryPath(asarPath, 'linux', 'x64')
    expect(result).toContain(`@esbuild${sep}linux-x64${sep}bin${sep}esbuild`)
    expect(result).toContain(`app.asar.unpacked`)
    expect(result).not.toContain(`${sep}app.asar${sep}`)
  })
})
