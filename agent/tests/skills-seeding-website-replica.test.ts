import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// See testHomeMock.ts for why the shared node:os home mock (not a locally-declared one) must be
// used, and skills-seeding-versioning.test.ts's file-level comment for why each describe block
// needs its own fake home + fresh seed-latch reset (seedBundledSkills() runs once per process).
import { homeMockState } from './testHomeMock'
import './testElectronMock'

const SKILL = 'website-replica'

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function skillDirFor(home: string): string {
  return join(home, '.klenny', 'skills', SKILL)
}

function seedStatePathFor(home: string): string {
  return join(home, '.klenny', 'skills-seed-state.json')
}

async function readSeedState(home: string): Promise<any> {
  return JSON.parse(await readFile(seedStatePathFor(home), 'utf8'))
}

/** `website-replica` is the only bundled skill that ships more than its SKILL.md: it carries a
 *  34-file Next.js project template as `assets`, without which the skill's instructions are
 *  useless. These tests cover that asset machinery (manager.ts's seedSkillAssets) — fresh seed,
 *  per-file edit detection across a version bump, and the repair pass — plus a drift guard tying
 *  the vendored files on disk to the manifest that registers them. */

describe('bundled skill "website-replica" seeds its SKILL.md and full project template', () => {
  let tempRoot: string

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-skills-seed-website-replica-'))
    homeMockState.homeDir = tempRoot

    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('a genuinely fresh install gets SKILL.md plus every template asset written verbatim', async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    const summaries = await listSkills() // triggers seedBundledSkills()

    const bundled = BUNDLED_SKILLS[SKILL]
    const raw = await readFile(join(skillDirFor(tempRoot), 'SKILL.md'), 'utf8')
    expect(raw).toBe(bundled.content)

    // Every asset lands at its declared path with byte-identical content. The manifest keys are
    // suffix-free by design — the `.txt` vendoring suffix is a build-tooling concern (see
    // websiteReplicaTemplate.ts) and must never leak into a seeded install.
    const assets = bundled.assets!
    expect(Object.keys(assets).length).toBeGreaterThan(0)
    for (const [rel, content] of Object.entries(assets)) {
      expect(rel.endsWith('.txt')).toBe(false)
      const onDisk = await readFile(join(skillDirFor(tempRoot), rel), 'utf8')
      expect(onDisk).toBe(content)
    }

    // Nested destinations really got their directories created, not flattened.
    const nested = await readFile(join(skillDirFor(tempRoot), 'template', 'app', 'lib', 'reveal.ts'), 'utf8')
    expect(nested.length).toBeGreaterThan(0)

    // The skill is discoverable through the normal catalog path, at global scope.
    const summary = summaries.find((s) => s.name === SKILL)
    expect(summary?.scope).toBe('global')

    const state = await readSeedState(tempRoot)
    expect(state.skills[SKILL].version).toBe(bundled.version)
    // Every asset's hash recorded — that's what the repair pass keys off.
    expect(Object.keys(state.skills[SKILL].assetHashes).sort()).toEqual(Object.keys(assets).sort())
  })
})

describe('bundled skill "website-replica" asset upgrades are per-file', () => {
  let tempRoot: string
  const OLD_SKILL_MD = '---\nname: website-replica\ndescription: an older shipped version\n---\n\nOld body.\n'
  const CUSTOMIZED = 'export const MY_OWN_TWEAK = true\n'
  const PRISTINE_OLD_ASSET = 'the exact bytes we last seeded for this file\n'
  const EDITED_REL = 'template/app/lib/reveal.ts'
  const PRISTINE_REL = 'template/package.json'

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-skills-seed-website-replica-upgrade-'))
    homeMockState.homeDir = tempRoot

    // Simulate an install that was seeded at an earlier version, where the user has since
    // customized ONE template file and left the rest alone. Recording version 0 makes the
    // bundled version (>=1) an upgrade.
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    const dir = skillDirFor(tempRoot)
    await mkdir(join(dir, 'template', 'app', 'lib'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), OLD_SKILL_MD, 'utf8')

    // Edited asset: on-disk content deliberately differs from the hash we "last wrote".
    await writeFile(join(dir, EDITED_REL), CUSTOMIZED, 'utf8')
    // Pristine asset: on-disk content matches the hash we "last wrote", so it's safe to update.
    await writeFile(join(dir, PRISTINE_REL), PRISTINE_OLD_ASSET, 'utf8')

    await writeFile(
      seedStatePathFor(tempRoot),
      JSON.stringify(
        {
          skills: {
            [SKILL]: {
              version: 0,
              hash: hashContent(OLD_SKILL_MD),
              assetHashes: {
                [EDITED_REL]: hashContent(PRISTINE_OLD_ASSET),
                [PRISTINE_REL]: hashContent(PRISTINE_OLD_ASSET)
              }
            }
          }
        },
        null,
        2
      ),
      'utf8'
    )
    expect(BUNDLED_SKILLS[SKILL].version).toBeGreaterThan(0) // guard: the setup above must be an upgrade

    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test("a user's customized template file survives, while pristine and missing files still update", async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    await listSkills()

    const bundled = BUNDLED_SKILLS[SKILL]
    const dir = skillDirFor(tempRoot)

    // SKILL.md itself was pristine at the old version, so it upgrades.
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(bundled.content)

    // The one file the user customized is untouched — this is the whole point of per-file
    // (rather than whole-template) edit detection.
    expect(await readFile(join(dir, EDITED_REL), 'utf8')).toBe(CUSTOMIZED)

    // ...while an unedited neighbour is brought up to date in the same pass.
    expect(await readFile(join(dir, PRISTINE_REL), 'utf8')).toBe(bundled.assets![PRISTINE_REL])

    // ...and files absent entirely are written, since a half-present template is broken.
    expect(await readFile(join(dir, 'template/scripts/capture.mjs'), 'utf8')).toBe(
      bundled.assets!['template/scripts/capture.mjs']
    )

    const state = await readSeedState(tempRoot)
    expect(state.skills[SKILL].version).toBe(bundled.version)
    // The edited file keeps its OLD recorded hash, so it stays classified as user-edited on every
    // future pass rather than being silently re-adopted as pristine.
    expect(state.skills[SKILL].assetHashes[EDITED_REL]).toBe(hashContent(PRISTINE_OLD_ASSET))
    expect(state.skills[SKILL].assetHashes[PRISTINE_REL]).toBe(hashContent(bundled.assets![PRISTINE_REL]))
  })
})

describe('bundled skill "website-replica" repairs a partially-written template', () => {
  let tempRoot: string
  const PRISTINE_REL = 'template/package.json'

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'klenny-skills-seed-website-replica-repair-'))
    homeMockState.homeDir = tempRoot

    // Simulate a previous launch that wrote SKILL.md and exactly one asset, then failed (or an
    // install whose record predates the skill having assets at all): the record sits at the
    // CURRENT version, so there's no upgrade to trigger a rewrite — only the repair pass can
    // notice the missing files.
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    const bundled = BUNDLED_SKILLS[SKILL]
    const dir = skillDirFor(tempRoot)
    await mkdir(join(dir, 'template'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), bundled.content, 'utf8')
    await writeFile(join(dir, PRISTINE_REL), bundled.assets![PRISTINE_REL], 'utf8')

    await writeFile(
      seedStatePathFor(tempRoot),
      JSON.stringify(
        {
          skills: {
            [SKILL]: {
              version: bundled.version,
              hash: hashContent(bundled.content),
              assetHashes: { [PRISTINE_REL]: hashContent(bundled.assets![PRISTINE_REL]) }
            }
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const { __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    __resetSeedStateForTests()
  })

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('unrecorded assets are topped up at the same version, without rewriting SKILL.md', async () => {
    const { listSkills } = await import('../src/main/agent/skills/manager')
    const { BUNDLED_SKILLS } = await import('../src/main/agent/skills/bundledSkills')
    await listSkills()

    const bundled = BUNDLED_SKILLS[SKILL]
    const dir = skillDirFor(tempRoot)

    for (const [rel, content] of Object.entries(bundled.assets!)) {
      expect(await readFile(join(dir, rel), 'utf8')).toBe(content)
    }
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toBe(bundled.content)

    const state = await readSeedState(tempRoot)
    expect(state.skills[SKILL].version).toBe(bundled.version)
    expect(Object.keys(state.skills[SKILL].assetHashes).sort()).toEqual(Object.keys(bundled.assets!).sort())
  })

  test('once every asset is recorded, a later launch leaves a deliberately deleted file alone', async () => {
    const { listSkills, __resetSeedStateForTests } = await import('../src/main/agent/skills/manager')
    const dir = skillDirFor(tempRoot)
    const victim = join(dir, 'template/scripts/dev.mjs')

    // Previous test left a fully-recorded state. Deleting a file now must NOT resurrect it: the
    // repair pass is keyed off unrecorded assets only, so steady state costs no filesystem work
    // and a user's deletion within an already-current install is respected.
    await rm(victim, { force: true })
    __resetSeedStateForTests()
    await listSkills()

    let existed = true
    try {
      await readFile(victim, 'utf8')
    } catch {
      existed = false
    }
    expect(existed).toBe(false)
  })
})

describe('website-replica template manifest matches the vendored files on disk', () => {
  test('every vendored .txt file is registered, and every registered key has a vendored file', async () => {
    const { WEBSITE_REPLICA_TEMPLATE } = await import('../src/main/agent/skills/websiteReplicaTemplate')
    const root = join(import.meta.dir, '..', 'src', 'main', 'agent', 'skills', 'bundled', 'website-replica-template')

    // Recursive walk (rather than readdir's `recursive` option) to keep this working regardless of
    // the Node/Bun version the suite runs under.
    async function walk(dir: string, prefix = ''): Promise<string[]> {
      const out: string[] = []
      for (const ent of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${ent.name}` : ent.name
        if (ent.isDirectory()) out.push(...(await walk(join(dir, ent.name), rel)))
        else out.push(rel)
      }
      return out
    }

    const vendored = await walk(root)
    expect(vendored.length).toBeGreaterThan(0)

    // Each vendored file is stored with an inert `.txt` suffix so this repo's tsc/bun-test never
    // sweep up the template's own sources; the manifest key is that path, suffix stripped.
    const expectedKeys = vendored.map((rel) => `template/${rel.replace(/\.txt$/, '')}`).sort()
    expect(Object.keys(WEBSITE_REPLICA_TEMPLATE).sort()).toEqual(expectedKeys)

    // Guard against a vendored file losing its suffix (which would expose it to tsc/bun test).
    for (const rel of vendored) expect(rel.endsWith('.txt')).toBe(true)

    // No entry should be empty — an empty `?raw` import means a broken/missing vendored file.
    for (const [rel, content] of Object.entries(WEBSITE_REPLICA_TEMPLATE)) {
      expect(typeof content).toBe('string')
      if (!rel.endsWith('.gitignore')) expect(content.length).toBeGreaterThan(0)
    }
  })
})
