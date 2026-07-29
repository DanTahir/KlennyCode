import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// See testHomeMock.ts for why the shared node:os home mock (not a locally-declared one) must be
// used. Each describe block below gets its own fake home + fresh dynamic import of manager.ts,
// since seedBundledSkills() only runs once per process (module-level `seedAttempted` latch) — a
// single shared home across tests would only exercise the "first ever seed" path once and skip
// the rest.
import { homeMockState } from './testHomeMock'

import './testElectronMock'

const BUNDLED_SKILL_PATH = ['browser-automation', 'SKILL.md']

describe('bundled skill versioned re-seeding', () => {
  let tempRoot: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-skills-seed-v1-'))
    homeMockState.homeDir = tempRoot

    // Simulate a legacy (pre-versioning) install: the old marker file present, the skill on disk
    // matching exactly the MOST RECENT variant ever shipped under the marker-only scheme, and
    // critically NO skills-seed-state.json yet.
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    const skillDir = join(homeMockState.homeDir, '.klenny', 'skills', ...BUNDLED_SKILL_PATH.slice(0, -1))
    await mkdir(skillDir, { recursive: true })
    const legacyVariants = BUNDLED_SKILLS['browser-automation'].legacyVariants
    await writeFile(join(skillDir, 'SKILL.md'), legacyVariants[legacyVariants.length - 1], 'utf8')
    await writeFile(join(homeMockState.homeDir, '.klenny', '.bundled-skills-seeded'), new Date().toISOString(), 'utf8')

    // seedBundledSkills() only runs once per process — reset the latch so this describe block's
    // seed attempt isn't a no-op if another test file already seeded first.
    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('an untouched legacy install on the most recent marker-only variant is upgraded to the current bundled content', async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    await listSkills() // triggers seedBundledSkills()

    const skillPath = join(homeMockState.homeDir, '.klenny', 'skills', 'browser-automation', 'SKILL.md')
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toBe(BUNDLED_SKILLS['browser-automation'].content)
    expect(raw).toContain('inspect') // the new content mentions the inspect action; legacy variants didn't

    const state = JSON.parse(await readFile(join(homeMockState.homeDir, '.klenny', 'skills-seed-state.json'), 'utf8'))
    expect(state.skills['browser-automation'].version).toBe(BUNDLED_SKILLS['browser-automation'].version)
  })
})

describe('bundled skill versioned re-seeding recognizes OLDER marker-only variants too', () => {
  let tempRoot: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-skills-seed-v1-oldvariant-'))
    homeMockState.homeDir = tempRoot

    // Simulate a legacy install seeded a long time ago, back when the FIRST-ever variant was the
    // current content (before later marker-only-era updates, and long before versioning). This is
    // the regression case: if the migration only recognized the most recent legacy variant, an
    // install like this would be wrongly treated as "user-edited" and permanently stuck.
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    const skillDir = join(homeMockState.homeDir, '.klenny', 'skills', ...BUNDLED_SKILL_PATH.slice(0, -1))
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), BUNDLED_SKILLS['browser-automation'].legacyVariants[0], 'utf8')
    await writeFile(join(homeMockState.homeDir, '.klenny', '.bundled-skills-seeded'), new Date().toISOString(), 'utf8')

    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('an untouched legacy install on the OLDEST marker-only variant is still upgraded, not mistaken for a user edit', async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    await listSkills()

    const skillPath = join(homeMockState.homeDir, '.klenny', 'skills', 'browser-automation', 'SKILL.md')
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toBe(BUNDLED_SKILLS['browser-automation'].content)

    const state = JSON.parse(await readFile(join(homeMockState.homeDir, '.klenny', 'skills-seed-state.json'), 'utf8'))
    expect(state.skills['browser-automation'].version).toBe(BUNDLED_SKILLS['browser-automation'].version)
  })
})

describe('bundled skill versioned re-seeding respects user edits', () => {
  let tempRoot: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-skills-seed-v1-edited-'))
    homeMockState.homeDir = tempRoot

    // Legacy install where the user has already customized the skill — content deliberately
    // does NOT match the frozen v1 baseline.
    const skillDir = join(homeMockState.homeDir, '.klenny', 'skills', ...BUNDLED_SKILL_PATH.slice(0, -1))
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: browser-automation\ndescription: my custom version\n---\n\nMy own notes.\n', 'utf8')
    await writeFile(join(homeMockState.homeDir, '.klenny', '.bundled-skills-seeded'), new Date().toISOString(), 'utf8')

    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test("a user's pre-existing edit under the legacy marker is never overwritten by the version bump", async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    await listSkills()

    const skillPath = join(homeMockState.homeDir, '.klenny', 'skills', 'browser-automation', 'SKILL.md')
    const raw = await readFile(skillPath, 'utf8')
    expect(raw).toContain('my custom version')
    expect(raw).toContain('My own notes.')
  })
})
