import { describe, expect, test, beforeEach } from 'bun:test'
import { join } from 'node:path'
import './testElectronMock' // registers a shared electron mock — see that file for why this matters
import { electronMockState } from './testElectronMock'

const { checkPawprintWriteGuard, checkPawprintStateSize, MAX_PAWPRINT_STATE_BYTES } = await import(
  '../src/main/agent/pawprints/writeGuard'
)
const { pawprintsRootDir, pawprintStatePath, pawprintSourceFile, pawprintManifestPath } = await import(
  '../src/main/agent/pawprints/paths'
)

beforeEach(() => {
  electronMockState.userDataDir = join('C:', 'fake-userdata')
})

describe('pawprints write guard — checkPawprintWriteGuard', () => {
  test('allows a path under state/**', () => {
    const res = checkPawprintWriteGuard(pawprintStatePath('sticky-notes', 'abc123'))
    expect(res.allowed).toBe(true)
  })

  test('rejects a direct write to source/**', () => {
    const res = checkPawprintWriteGuard(pawprintSourceFile('sticky-notes'))
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/update_pawprint/)
  })

  test('rejects a direct write to manifest.json', () => {
    const res = checkPawprintWriteGuard(pawprintManifestPath('sticky-notes'))
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/update_pawprint/)
  })

  test('rejects a path-traversal attempt that resolves into source/**', () => {
    const traversal = join(pawprintsRootDir(), 'sticky-notes', 'state', '..', 'source', 'App.tsx')
    const res = checkPawprintWriteGuard(traversal)
    expect(res.allowed).toBe(false)
  })

  test('rejects a write under node_modules or any other subdir', () => {
    const res = checkPawprintWriteGuard(join(pawprintsRootDir(), 'sticky-notes', 'node_modules', 'react', 'index.js'))
    expect(res.allowed).toBe(false)
  })

  test('is a no-op for a path outside the pawprints root entirely', () => {
    const res = checkPawprintWriteGuard(join('C:', 'fake-userdata', 'skills', 'my-skill', 'SKILL.md'))
    expect(res.allowed).toBe(true)
  })

  test('is a no-op for the pawprints root itself with no subpath', () => {
    const res = checkPawprintWriteGuard(pawprintsRootDir())
    expect(res.allowed).toBe(true)
  })

  test('is a no-op for a bare pawprint id directory with no subpath', () => {
    const res = checkPawprintWriteGuard(join(pawprintsRootDir(), 'sticky-notes'))
    expect(res.allowed).toBe(true)
  })
})

describe('pawprints write guard — checkPawprintStateSize', () => {
  test('allows a write under the cap', () => {
    const res = checkPawprintStateSize(1024)
    expect(res.allowed).toBe(true)
  })

  test('allows a write exactly at the cap', () => {
    const res = checkPawprintStateSize(MAX_PAWPRINT_STATE_BYTES)
    expect(res.allowed).toBe(true)
  })

  test('rejects a write over the cap with a clear error, not a truncation', () => {
    const res = checkPawprintStateSize(MAX_PAWPRINT_STATE_BYTES + 1)
    expect(res.allowed).toBe(false)
    expect(res.reason).toMatch(/exceeds/)
  })
})
