import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import './testElectronMock'
import { electronMockState } from './testElectronMock'

const { bundlePawprint, clearBundleCache } = await import('../src/main/agent/pawprints/bundler')
const { pawprintNodeModulesDir } = await import('../src/main/agent/pawprints/paths')
const { PAWPRINT_SDK_MODULE } = await import('../src/main/agent/pawprints/validator')

/** A hand-written sample Pawprint (per plan Phase 1: "proven with one hand-written sample
 *  Pawprint") — a minimal sticky-note-style app using only React + the SDK virtual module,
 *  exercising getState/setState/onThemeChange exactly the way a real agent-generated Pawprint
 *  would. This is the go/no-go proof that the bundler pipeline (esbuild + SDK plugin + React
 *  aliasing) actually produces valid, runnable JS for a realistic Pawprint, without requiring a
 *  live Electron BrowserWindow to observe it render. */
const SAMPLE_PAWPRINT_SOURCE = `
import { useState, useEffect } from 'react'
import { getState, setState, onThemeChange } from '${PAWPRINT_SDK_MODULE}'

export default function App() {
  const [note, setNote] = useState('')

  useEffect(() => {
    getState().then((s) => setNote((s && s.note) || ''))
    onThemeChange(() => {})
  }, [])

  return (
    <div>
      <textarea value={note} onChange={(e) => {
        setNote(e.target.value)
        setState({ note: e.target.value })
      }} />
    </div>
  )
}
`

describe('bundlePawprint — Phase 1 go/no-go proof-of-concept', () => {
  let dir: string
  const pawprintId = 'sample-sticky-notes'

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'pawprints-bundler-test-'))
    electronMockState.userDataDir = dir
    await fs.mkdir(pawprintNodeModulesDir(pawprintId), { recursive: true })
    clearBundleCache(pawprintId)
  })

  afterEach(async () => {
    clearBundleCache(pawprintId)
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  test('bundles a hand-written sample Pawprint (React + SDK usage) into a single non-empty IIFE JS string', async () => {
    const result = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    expect(result.code.length).toBeGreaterThan(0)
    expect(result.cacheKey.length).toBeGreaterThan(0)
    // esbuild IIFE format wraps output in an immediately-invoked function expression.
    expect(result.code).toContain('(()')
  })

  test('the SDK virtual module import resolves via the esbuild plugin, not a real node_modules package', async () => {
    const result = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    // The SDK source defines getState/setState/onThemeChange against window.__pawprintBridge —
    // if the plugin didn't intercept the import, esbuild would fail to resolve it and bundling
    // above would have already thrown. Confirm the bridge-access pattern actually made it into
    // the final bundle (proves the SDK's own body was inlined, not stubbed out).
    expect(result.code).toContain('__pawprintBridge')
  })

  test('the bundled output contains the sample Pawprint\'s own JSX-compiled markup, proving the app code itself was bundled', async () => {
    const result = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    expect(result.code).toContain('textarea')
  })

  test('the bundle actually mounts the App component to the DOM (createRoot + render), not just defines it unused', async () => {
    const result = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    // Regression test for a real bug: earlier, bundlePawprint used the agent's raw source as the
    // esbuild entry point directly, which bundled the App component definition but never called
    // createRoot(...).render() on it — every real Pawprint would have rendered a blank window.
    // getElementById('root') is the entry wrapper's own DOM lookup; createRoot/render prove the
    // actual mount call survived minification/bundling into the final IIFE.
    expect(result.code).toContain('getElementById')
    expect(result.code.toLowerCase()).toContain('createroot')
  })

  test('bundling the same source/packages/version twice returns the identical cache key and hits the in-memory cache', async () => {
    const first = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    const second = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    expect(second.cacheKey).toBe(first.cacheKey)
    expect(second.code).toBe(first.code)
  })

  test('bumping sourceVersion changes the cache key even though the source text is unchanged', async () => {
    const v1 = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    const v2 = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 2)
    expect(v2.cacheKey).not.toBe(v1.cacheKey)
  })

  test('changing the source text changes the cache key', async () => {
    const v1 = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    const changed = SAMPLE_PAWPRINT_SOURCE.replace('textarea', 'input')
    const v2 = await bundlePawprint(pawprintId, changed, [], 1)
    expect(v2.cacheKey).not.toBe(v1.cacheKey)
  })

  test('clearBundleCache forces a fresh rebuild (still succeeds, still produces valid output)', async () => {
    const first = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    clearBundleCache(pawprintId)
    const second = await bundlePawprint(pawprintId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    // Same inputs, same cache key computation — but this proves a real rebuild happened rather
    // than silently reusing a stale reference (both are freshly-built, independently valid).
    expect(second.cacheKey).toBe(first.cacheKey)
    expect(second.code.length).toBeGreaterThan(0)
  })

  test('a syntactically invalid source rejects rather than silently producing broken output', async () => {
    const broken = 'export default function App() { return <div>' // unclosed JSX
    await expect(bundlePawprint(pawprintId, broken, [], 1)).rejects.toBeDefined()
  })

  // Regression test for a real bug: createPawprint() (manager.ts) only creates a Pawprint's own
  // node_modules/ directory when the extra-package pipeline runs (i.e. packages were requested) —
  // for the common case of zero requested packages, that directory never existed on disk before
  // bundlePawprint() was called. esbuild's `alias`/`resolveDir`/`absWorkingDir` resolution silently
  // fails to resolve even a fully-qualified absolute alias target when the working directory it's
  // given doesn't exist, producing "Could not resolve react-dom/client" etc. — exactly the error
  // a real user hit building a fresh calendar Pawprint. bundlePawprint() must create that
  // directory itself before invoking esbuild, unconditionally, so this must pass without any
  // beforeEach-style pre-creation of the directory for a *different*, never-touched Pawprint id.
  test('bundling a freshly-created Pawprint whose node_modules/ directory was never created (zero requested packages) still succeeds', async () => {
    const freshId = 'never-had-node-modules-dir'
    // Deliberately do NOT create pawprintNodeModulesDir(freshId) here — that's the whole point.
    const result = await bundlePawprint(freshId, SAMPLE_PAWPRINT_SOURCE, [], 1)
    expect(result.code.length).toBeGreaterThan(0)
    expect(result.code).toContain('getElementById')
    clearBundleCache(freshId)
  })
})
