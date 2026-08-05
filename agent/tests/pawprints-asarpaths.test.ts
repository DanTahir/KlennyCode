import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { resolveForExternalProcess, toUnpackedAsarPath } from '../src/main/agent/pawprints/asarPaths'

// Regression coverage for Bug #11 ("Could not resolve ... react-dom\\client.js" only in the
// packaged app, never in `npm run dev`). See asarPaths.ts's own doc comment for the full
// root-cause writeup — esbuild's `alias` option is read directly by its own external spawned
// process, so an app.asar-internal path computed via require.resolve() at module load is simply
// not a file that process can see; the fix redirects such paths to their app.asar.unpacked
// mirror when one actually exists on disk. The full end-to-end fix (bundler.ts's REACT_ALIASES,
// vettedLibraries.ts's resolveBrowserSafeEntry, and the extended package.json asarUnpack globs)
// was additionally verified directly against a real electron-builder --dir packaged app.asar via
// ELECTRON_RUN_AS_NODE=1, not just by this unit test — asar/electron-builder packaging behavior
// isn't something bun:test can exercise directly. These tests cover only the pure/fs-backed
// helper functions themselves.

describe('toUnpackedAsarPath (pure string transform)', () => {
  test('returns the input unchanged when it contains no app.asar segment (dev/test mode)', () => {
    const devPath = ['C:', 'some', 'project', 'node_modules', 'react', 'index.js'].join(sep)
    expect(toUnpackedAsarPath(devPath)).toBe(devPath)
  })

  test('swaps app.asar for app.asar.unpacked, preserving the rest of the path exactly', () => {
    const asarPath = ['C:', 'app', 'resources', 'app.asar', 'node_modules', 'react-dom', 'client.js'].join(sep)
    const expected = ['C:', 'app', 'resources', 'app.asar.unpacked', 'node_modules', 'react-dom', 'client.js'].join(
      sep
    )
    expect(toUnpackedAsarPath(asarPath)).toBe(expected)
  })

  test('does not touch a path that already says app.asar.unpacked (no accidental double-swap)', () => {
    const alreadyUnpacked = ['C:', 'app', 'resources', 'app.asar.unpacked', 'node_modules', 'react', 'index.js'].join(
      sep
    )
    // app.asar.unpacked does not contain the exact `${sep}app.asar${sep}` marker (it's
    // `${sep}app.asar.unpacked${sep}`), so this must be returned unchanged.
    expect(toUnpackedAsarPath(alreadyUnpacked)).toBe(alreadyUnpacked)
  })

  test('never throws on an empty string or a path with no directory separators', () => {
    expect(toUnpackedAsarPath('')).toBe('')
    expect(toUnpackedAsarPath('no-separators-here')).toBe('no-separators-here')
  })
})

describe('resolveForExternalProcess (fs-backed fallback)', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'klenny-asarpaths-test-'))

  test('returns the original path unchanged when it is not inside an app.asar archive at all', () => {
    const devPath = join(tmpRoot, 'node_modules', 'react', 'index.js')
    expect(resolveForExternalProcess(devPath)).toBe(devPath)
  })

  test('redirects to the app.asar.unpacked mirror when that file actually exists on disk', () => {
    const asarDir = join(tmpRoot, 'app.asar', 'node_modules', 'react-dom')
    const unpackedDir = join(tmpRoot, 'app.asar.unpacked', 'node_modules', 'react-dom')
    mkdirSync(unpackedDir, { recursive: true })
    const unpackedFile = join(unpackedDir, 'client.js')
    writeFileSync(unpackedFile, '// stub')
    expect(existsSync(unpackedFile)).toBe(true)

    const asarPath = join(asarDir, 'client.js')
    expect(resolveForExternalProcess(asarPath)).toBe(unpackedFile)
  })

  test('falls back to the original (broken-when-packaged) path when no unpacked mirror exists on disk', () => {
    const asarPath = join(tmpRoot, 'app.asar', 'node_modules', 'some-package-never-unpacked', 'index.js')
    // Deliberately never created on disk — simulates a package aliased via require.resolve()
    // but missing its own asarUnpack glob entry in package.json.
    expect(resolveForExternalProcess(asarPath)).toBe(asarPath)
  })

  rmSync(tmpRoot, { recursive: true, force: true })
})
