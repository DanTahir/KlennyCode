import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// See testHomeMock.ts for why the shared node:os home mock (not a locally-declared one) must be
// used, and skills-seeding-versioning.test.ts's file-level comment for why each describe block
// needs its own fake home + fresh seed-latch reset.
import { homeMockState } from './testHomeMock'
import './testElectronMock'

describe('bundled skill "pawprint-authoring" seeds on a brand-new install (no legacy history)', () => {
  let tempRoot: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-skills-seed-pawprint-authoring-'))
    homeMockState.homeDir = tempRoot

    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('a genuinely fresh install (no seed-state, no legacy marker) gets the current bundled content written verbatim', async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    const summaries = await listSkills() // triggers seedBundledSkills()

    const skillPath = join(homeMockState.homeDir, '.klenny', 'skills', 'pawprint-authoring', 'SKILL.md')
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toBe(BUNDLED_SKILLS['pawprint-authoring'].content)
    expect(raw).toContain('create_pawprint')
    expect(raw).toContain('img-src')

    const state = JSON.parse(await readFile(join(homeMockState.homeDir, '.klenny', 'skills-seed-state.json'), 'utf8'))
    expect(state.skills['pawprint-authoring'].version).toBe(BUNDLED_SKILLS['pawprint-authoring'].version)

    const summary = summaries.find((s) => s.name === 'pawprint-authoring')
    expect(summary?.scope).toBe('global')
    expect(summary?.description).toContain('Pawprint')
  })
})
