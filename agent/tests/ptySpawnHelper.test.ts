import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureExecutable, spawnHelperCandidates, toUnpackedPath } from '../src/main/ptySpawnHelper'

const isWindows = process.platform === 'win32'

describe('toUnpackedPath', () => {
  test('rewrites app.asar to app.asar.unpacked', () => {
    expect(toUnpackedPath('/A/Resources/app.asar/node_modules/node-pty')).toBe(
      '/A/Resources/app.asar.unpacked/node_modules/node-pty'
    )
  })
  test('is idempotent on an already-unpacked path', () => {
    const p = '/A/Resources/app.asar.unpacked/node_modules/node-pty'
    expect(toUnpackedPath(p)).toBe(p)
  })
  test('leaves non-asar (dev) paths alone', () => {
    expect(toUnpackedPath('/repo/agent/node_modules/node-pty')).toBe('/repo/agent/node_modules/node-pty')
  })
})

describe('spawnHelperCandidates', () => {
  test('includes the platform-arch prebuild and build/Release', () => {
    const c = spawnHelperCandidates('/pty', 'darwin', 'arm64')
    expect(c).toContain(join('/pty', 'prebuilds', 'darwin-arm64', 'spawn-helper'))
    expect(c).toContain(join('/pty', 'build', 'Release', 'spawn-helper'))
  })
})

describe('ensureExecutable', () => {
  test.skipIf(isWindows)('adds the execute bit to a 0644 file (the node-pty 1.1.0 tarball defect)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'klenny-pty-'))
    try {
      const helper = join(dir, 'prebuilds', 'darwin-arm64', 'spawn-helper')
      mkdirSync(join(dir, 'prebuilds', 'darwin-arm64'), { recursive: true })
      writeFileSync(helper, '#!/bin/sh\n')
      chmodSync(helper, 0o644)

      const r = ensureExecutable([helper, join(dir, 'missing', 'spawn-helper')])
      expect(r.fixed).toEqual([helper])
      expect(r.failed).toEqual([])
      expect(statSync(helper).mode & 0o777).toBe(0o755)

      // Second pass: already executable, nothing to do.
      expect(ensureExecutable([helper])).toEqual({ fixed: [], failed: [] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('skips paths that do not exist', () => {
    expect(ensureExecutable([join(tmpdir(), 'definitely-not-here-klenny', 'spawn-helper')])).toEqual({
      fixed: [],
      failed: []
    })
  })
})
