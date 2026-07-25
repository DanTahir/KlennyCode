import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mock } from 'bun:test'
import { mkdtemp, rm, access, readFile, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Redirect the global Klenny dir (~/.klenny) to an isolated temp "home" so this test never
// touches the real user home directory. Must be mocked before dataDir.ts (which calls
// homedir() from node:os) is loaded anywhere in the process.
let fakeHome = ''

mock.module('node:os', () => ({
  homedir: () => fakeHome,
  tmpdir
}))

// Shared electron mock (getWorkspace() pulls in workspace.ts -> electron).
import './testElectronMock'

describe('bundled skill seeding', () => {
  let tempRoot: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-skills-seed-'))
    fakeHome = tempRoot
    // seedBundledSkills() only runs once per process (module-level latch) — reset it so this
    // file's seed attempt isn't a no-op if another test file already triggered it first when the
    // whole suite runs together.
    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('seeds the bundled browser-automation skill on first run', async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    const skills = await listSkills()
    const browserSkill = skills.find((s) => s.name === 'browser-automation')
    expect(browserSkill).toBeDefined()
    expect(browserSkill?.scope).toBe('global')

    const skillPath = join(fakeHome, '.klenny', 'skills', 'browser-automation', 'SKILL.md')
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toContain('browser-automation')

    // Versioned seed-state file written so a fresh process wouldn't reseed/downgrade, and future
    // version bumps have a baseline hash to compare against.
    const stateRaw = await readFile(join(fakeHome, '.klenny', 'skills-seed-state.json'), 'utf8')
    const state = JSON.parse(stateRaw)
    expect(state.skills['browser-automation'].version).toBeGreaterThanOrEqual(1)
    expect(typeof state.skills['browser-automation'].hash).toBe('string')
  })

  test('does not resurrect a bundled skill the user deleted, on a later listSkills() call', async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    const skillDir = join(fakeHome, '.klenny', 'skills', 'browser-automation')

    // Simulate the user deleting the bundled skill after the initial seed above.
    await rm(join(skillDir, 'SKILL.md'), { force: true })
    await rmdir(skillDir).catch(() => {})

    const skills = await listSkills()
    expect(skills.find((s) => s.name === 'browser-automation')).toBeUndefined()

    // Still no SKILL.md — deletion respected, not silently reseeded.
    await expect(access(join(skillDir, 'SKILL.md'))).rejects.toBeDefined()
  })
})
