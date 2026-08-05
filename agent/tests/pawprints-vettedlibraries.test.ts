import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import './testElectronMock'
import { electronMockState } from './testElectronMock'

const { validatePawprintSource, PAWPRINT_SDK_MODULE } = await import('../src/main/agent/pawprints/validator')
const { bundlePawprint, clearBundleCache } = await import('../src/main/agent/pawprints/bundler')
const { pawprintNodeModulesDir } = await import('../src/main/agent/pawprints/paths')
const { VETTED_LIBRARY_NAMES } = await import('../src/main/agent/pawprints/vettedLibraries')

/**
 * Phase 8 ("Vetted library curation and bundling", plan section 7): a small, explicit allowlist
 * of libraries pre-bundled with Klenny itself and importable by any Pawprint without going
 * through the agent-proposed extra-package pipeline (packagePipeline.ts) or appearing in that
 * Pawprint's approved-packages list. v1 ships exactly one entry, `nanoid` (already a direct
 * dependency of this app), as the initial, minimal proof that the mechanism works end-to-end;
 * the list (vettedLibraries.ts) is designed to grow over time without touching the validator or
 * bundler again.
 */
describe('Phase 8 — vetted library allowlist (nanoid)', () => {
  test('the vetted library list is non-empty and includes nanoid', () => {
    expect(VETTED_LIBRARY_NAMES.length).toBeGreaterThan(0)
    expect(VETTED_LIBRARY_NAMES).toContain('nanoid')
  })

  test('validator allows importing a vetted library with zero approved extra packages', async () => {
    const source = `
import { nanoid } from 'nanoid'
export default function App() {
  return <div>{nanoid()}</div>
}
`
    const result = await validatePawprintSource(source, [])
    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  test('validator still rejects a non-vetted, non-approved, non-SDK import', async () => {
    const source = `
import leftpad from 'left-pad'
export default function App() {
  return <div>{leftpad('x', 5)}</div>
}
`
    const result = await validatePawprintSource(source, [])
    expect(result.ok).toBe(false)
    expect(result.errors.some((e) => e.includes('left-pad'))).toBe(true)
  })

  describe('bundler resolves vetted libraries against Klenny\'s own node_modules', () => {
    let dir: string
    const pawprintId = 'sample-vetted-lib-user'

    beforeEach(async () => {
      dir = await fs.mkdtemp(join(tmpdir(), 'pawprints-vettedlib-test-'))
      electronMockState.userDataDir = dir
      await fs.mkdir(pawprintNodeModulesDir(pawprintId), { recursive: true })
      clearBundleCache(pawprintId)
    })

    afterEach(async () => {
      clearBundleCache(pawprintId)
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    })

    test('bundles a Pawprint that imports nanoid without listing it as an approved extra package', async () => {
      const source = `
import { useState } from 'react'
import { nanoid } from 'nanoid'
import { getState, setState } from '${PAWPRINT_SDK_MODULE}'

export default function App() {
  const [id] = useState(() => nanoid())
  return <div data-id={id} onClick={() => setState({ id })}>{id}</div>
}
`
      // packages: [] — proves nanoid resolves via the vetted-library alias, not the extra-package pipeline.
      const result = await bundlePawprint(pawprintId, source, [], 1)
      expect(result.code.length).toBeGreaterThan(0)
      // nanoid's own implementation is small and distinctive enough that its inlined body should
      // survive bundling — a loose but meaningful signal that resolution actually succeeded rather
      // than esbuild silently producing an empty/stubbed module.
      expect(result.code).toContain('nanoid')
    })
  })
})
