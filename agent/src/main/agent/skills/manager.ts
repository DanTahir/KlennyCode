import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { SkillSummary } from '@shared/types'
import { getWorkspace } from '../../workspace'
import { globalKlennyDir } from '../../dataDir'
import { BUNDLED_SKILLS } from './bundledSkills'

/** Bundled skills the app ships with, seeded into the global skills dir as real SKILL.md files a
 *  user can see, edit, or delete via the Skills panel, rather than a hardcoded prompt block.
 *
 *  Versioned re-seeding: each entry in BUNDLED_SKILLS carries a `version` int. seed-state.json
 *  (in the global Klenny dir) records, per skill, the version + content hash we last wrote. On
 *  every launch, for each bundled skill:
 *    - Never seeded before -> write it, record version + hash.
 *    - Seeded before, bundled version is newer, AND the file on disk still matches the hash we
 *      last wrote (i.e. the user hasn't edited it) -> overwrite with the new content, record the
 *      new version + hash. This is how a `bundledSkills.ts` content/version bump reaches existing
 *      installs without ever clobbering a user's own edits.
 *    - Seeded before, bundled version is newer, but the on-disk content's hash doesn't match what
 *      we last wrote (the user edited or replaced it) -> leave it alone. The user's version wins,
 *      permanently, for that skill, until they delete it (which makes it re-seed fresh) or
 *      manually match the new bundled content.
 *    - User deleted the skill file entirely -> NOT re-seeded (matches the old marker-file
 *      behavior's intent: deletion is a deliberate, respected choice, not "reset to defaults"). */
interface SeedRecord {
  version: number
  hash: string
}
interface SeedState {
  skills: Record<string, SeedRecord>
}

function seedStatePath(): string {
  return join(globalKlennyDir(), 'skills-seed-state.json')
}

/** Older installs (pre-versioning) only have this marker, no skills-seed-state.json. Its
 *  presence means "already did the original one-time seed" — treated as every bundled skill
 *  being at version 1, with its baseline hash checked against BundledSkill.legacyVariants (the
 *  frozen historical content variants actually shipped under this marker-only scheme, not
 *  whatever happens to be on disk) so the first versioned bump (2) can still correctly tell
 *  whether the user has edited their copy since. */
function legacyMarkerPath(): string {
  return join(globalKlennyDir(), '.bundled-skills-seeded')
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

async function readSeedState(): Promise<SeedState> {
  try {
    const raw = await readFile(seedStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.skills) return parsed as SeedState
  } catch {
    // absent or corrupt — treated as empty below
  }
  return { skills: {} }
}

async function writeSeedState(state: SeedState): Promise<void> {
  try {
    await mkdir(globalKlennyDir(), { recursive: true })
    await writeFile(seedStatePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // best-effort — worst case this re-evaluates (harmlessly) on the next launch
  }
}

let seedAttempted = false

/** Test-only: resets the in-memory "already tried seeding this process" latch so a subsequent
 *  seedBundledSkills() call (e.g. via listSkills()) re-evaluates from scratch against a fresh
 *  fake home directory, instead of being a no-op because some earlier test file in the same
 *  `bun test` process already seeded once. Not used by production code paths. */
export function __resetSeedStateForTests(): void {
  seedAttempted = false
}

async function seedBundledSkills(): Promise<void> {
  if (seedAttempted) return
  seedAttempted = true

  const globalDir = join(globalKlennyDir(), 'skills')
  const state = await readSeedState()

  let hadLegacyMarker = false
  if (!Object.keys(state.skills).length) {
    try {
      await access(legacyMarkerPath())
      hadLegacyMarker = true
    } catch {
      // no legacy marker either — genuinely brand-new install
    }
  }

  let stateChanged = false
  for (const [name, skill] of Object.entries(BUNDLED_SKILLS)) {
    const path = join(globalDir, name, 'SKILL.md')

    let onDisk: string | null = null
    try {
      onDisk = await readFile(path, 'utf8')
    } catch {
      onDisk = null // not seeded yet, or user deleted it
    }

    // Establish a record for this skill if it doesn't have one yet — either a genuinely fresh
    // seed (brand-new install) or a one-time legacy-marker migration (see legacyMarkerPath's doc
    // comment). Falls through to the version-check/upgrade below in the same pass, rather than
    // requiring a second launch, so a legacy install that's due for an update gets it on the very
    // next launch after this migration ships, not the one after that.
    if (!state.skills[name]) {
      if (onDisk === null) {
        if (hadLegacyMarker) {
          // Legacy install that predates seed-state.json but the file is missing — the user
          // deliberately deleted a bundled skill under the old marker-file scheme. Respect that;
          // don't resurrect it.
          continue
        }
        // Genuinely never seeded — write the current content directly; nothing to "upgrade" to.
        try {
          await mkdir(join(globalDir, name), { recursive: true })
          await writeFile(path, skill.content, 'utf8')
          state.skills[name] = { version: skill.version, hash: hashContent(skill.content) }
          stateChanged = true
        } catch {
          // best-effort — this skill just won't be offered this run
        }
        continue
      } else if (hadLegacyMarker) {
        // Legacy install, file exists on disk from the old one-time seed, but we have no
        // recorded hash for it yet. The old marker-only scheme never recorded *which* content was
        // seeded, and the shipped content could have changed more than once before versioning
        // existed — so compare against every known historical variant (see bundledSkills.ts's
        // `legacyVariants` doc comment), not just one frozen baseline. Only adopt "version 1" as
        // the baseline if the on-disk content genuinely matches one of them, so a user's
        // pre-existing edit is correctly detected as "edited" (record stays absent -> falls into
        // the "not a legacy install and no record" no-op below on every future launch) rather than
        // being silently locked in as the new baseline, and so someone on an *older* legacy
        // variant than the most recent one isn't wrongly treated as having edited the file.
        const onDiskHash = hashContent(onDisk)
        const matchesKnownLegacyVariant = skill.legacyVariants.some((variant) => hashContent(variant) === onDiskHash)
        if (matchesKnownLegacyVariant) {
          state.skills[name] = { version: 1, hash: onDiskHash }
          stateChanged = true
          // Fall through (no `continue`) so this same pass can also apply a v2+ upgrade below,
          // instead of waiting for a second launch.
        } else {
          // User had already edited it before this update shipped — leave no record, which is a
          // permanent no-op for this skill (never overwrite an edit) until they delete it.
          continue
        }
      } else {
        // Not a legacy install and no record — not one of our bundled skills as far as this
        // install has ever known; leave it untouched.
        continue
      }
    }

    const record = state.skills[name]
    if (skill.version <= record.version) continue // nothing newer to offer
    if (onDisk === null) continue // user deleted it — respect that, don't resurrect
    if (hashContent(onDisk) !== record.hash) continue // user edited it — never overwrite

    try {
      await writeFile(path, skill.content, 'utf8')
      state.skills[name] = { version: skill.version, hash: hashContent(skill.content) }
      stateChanged = true
    } catch {
      // best-effort — retried next launch since state.skills[name] wasn't updated
    }
  }

  if (stateChanged) await writeSeedState(state)
}

export async function listSkills(): Promise<SkillSummary[]> {
  await seedBundledSkills()
  const out: SkillSummary[] = []
  const ws = getWorkspace()
  if (ws) {
    const projDir = join(ws, '.klenny', 'skills')
    out.push(...(await scanSkillsDir(projDir, 'project')))
  }
  const globalDir = join(globalKlennyDir(), 'skills')
  out.push(...(await scanSkillsDir(globalDir, 'global')))
  return out
}

async function scanSkillsDir(dir: string, scope: 'project' | 'global'): Promise<SkillSummary[]> {
  const out: SkillSummary[] = []
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isDirectory()) continue
      const skillPath = join(dir, ent.name, 'SKILL.md')
      try {
        const raw = await readFile(skillPath, 'utf8')
        const { data } = matter(raw)
        out.push({
          name: String(data.name ?? ent.name),
          description: String(data.description ?? ''),
          scope,
          path: skillPath
        })
      } catch {
        // skip
      }
    }
  } catch {
    // no dir
  }
  return out
}

export async function readSkill(path: string): Promise<string> {
  const raw = await readFile(path, 'utf8')
  const { content } = matter(raw)
  return content.trim()
}

export async function writeSkill(
  name: string,
  scope: 'project' | 'global',
  description: string,
  body: string
): Promise<void> {
  let base: string
  if (scope === 'global') {
    base = join(globalKlennyDir(), 'skills', name)
  } else {
    const ws = getWorkspace()
    if (!ws) throw new Error('No workspace open — cannot write a project-scoped skill')
    base = join(ws, '.klenny', 'skills', name)
  }
  await mkdir(base, { recursive: true })
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n\n`
  await writeFile(join(base, 'SKILL.md'), frontmatter + body.trim() + '\n', 'utf8')
}

export function skillsCatalogPrompt(skills: SkillSummary[]): string {
  if (!skills.length) return ''
  const lines = skills.map((s) => `- ${s.name} (${s.scope}): ${s.description}`)
  return `Available skills (call read_skill when relevant):\n${lines.join('\n')}`
}
