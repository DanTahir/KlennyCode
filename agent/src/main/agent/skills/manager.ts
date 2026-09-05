import { readFile, writeFile, mkdir, readdir, access, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { parseFrontmatterSafe, stringifyFrontmatter } from '../frontmatter'
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
 *      behavior's intent: deletion is a deliberate, respected choice, not "reset to defaults").
 *
 *  Multi-file skills: a bundled skill may also ship `assets` (see BundledSkill.assets) — extra
 *  files written into its seeded skill dir alongside SKILL.md, used by `website-replica`, whose
 *  SKILL.md is useless without the project template it tells the agent to copy. Assets follow the
 *  same never-clobber-an-edit contract, but tracked *per file* (`assetHashes`) rather than as one
 *  blob, so a user who customises one template file keeps that file and still receives updates to
 *  all the others. Two deliberate differences from SKILL.md:
 *    - A deleted asset IS rewritten during a version-upgrade or repair pass (a half-present
 *      template is broken, and template internals aren't discrete user-facing units the way a
 *      whole skill is — deleting the *skill* still keeps everything gone).
 *    - Assets whose write failed leave their hash unrecorded, which is what the repair pass keys
 *      off (see seedSkillAssets), so a partially-written template self-heals on the next launch
 *      without needing to stat every asset on every launch. */
interface SeedRecord {
  version: number
  /** Hash of the SKILL.md content we last wrote — unchanged in meaning by the addition of
   *  assets below, so older seed-state.json files stay readable as-is. */
  hash: string
  /** Asset relative path -> hash of the content we last wrote for it. Absent for skills that
   *  ship no assets, and for records written before asset support existed (an absent/partial map
   *  is exactly what triggers the repair pass). */
  assetHashes?: Record<string, string>
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

/** Writes a bundled skill's `assets` into its seeded skill dir and returns the asset->hash map to
 *  record. Never throws: each file is best-effort, and a failed write is simply left out of the
 *  returned map so the next launch's repair pass retries it.
 *
 *  Per-file decisions, given the hash we last wrote for that file (`prevHashes`):
 *    - on disk, but its content doesn't match what we last wrote -> user customised it. Keep their
 *      file, and keep re-reporting the *old* hash so it stays classified as edited on every future
 *      pass instead of being silently re-adopted as pristine.
 *    - missing, or present and pristine -> write the current bundled content.
 *  Callers decide *when* a pass happens (fresh seed / version upgrade / repair); this function
 *  only decides what to do with each individual file once a pass is underway. */
async function seedSkillAssets(
  skillDir: string,
  assets: Record<string, string> | undefined,
  prevHashes: Record<string, string>
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {}
  if (!assets) return hashes
  const root = resolve(skillDir)

  for (const [rel, content] of Object.entries(assets)) {
    const dest = resolve(skillDir, rel)
    // Defence in depth: asset keys are hardcoded in-repo rather than user input, but this is a
    // filesystem write path, so refuse anything that resolves outside the skill's own directory
    // instead of trusting the manifest to be well-formed.
    if (dest !== root && !dest.startsWith(root + sep)) continue

    const prev = prevHashes[rel]
    let onDisk: string | null = null
    try {
      onDisk = await readFile(dest, 'utf8')
    } catch {
      onDisk = null // never written, write failed previously, or user deleted it
    }

    if (onDisk !== null && prev !== undefined && hashContent(onDisk) !== prev) {
      hashes[rel] = prev
      continue
    }

    const target = hashContent(content)
    if (onDisk !== null && hashContent(onDisk) === target) {
      hashes[rel] = target // already current — no write needed
      continue
    }

    try {
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, content, 'utf8')
      hashes[rel] = target
    } catch {
      // best-effort — hash deliberately left unrecorded so the repair pass retries next launch
    }
  }

  return hashes
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
          const assetHashes = await seedSkillAssets(join(globalDir, name), skill.assets, {})
          state.skills[name] = {
            version: skill.version,
            hash: hashContent(skill.content),
            ...(skill.assets ? { assetHashes } : {})
          }
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

    // Repair pass: bundled assets with no recorded hash were never successfully written — either a
    // previous launch's write failed partway, or this install's record predates the skill gaining
    // assets at all. Top those up without touching SKILL.md (which is already current at this
    // version). Keyed purely off recorded state, so the common steady-state case costs no
    // filesystem calls; only genuinely-unrecorded files are touched.
    if (skill.assets && onDisk !== null && skill.version <= record.version) {
      const recorded = record.assetHashes ?? {}
      const unrecorded = Object.keys(skill.assets).filter((rel) => !(rel in recorded))
      if (unrecorded.length) {
        const assetHashes = await seedSkillAssets(join(globalDir, name), skill.assets, recorded)
        state.skills[name] = { ...record, assetHashes }
        stateChanged = true
      }
    }

    if (skill.version <= record.version) continue // nothing newer to offer
    if (onDisk === null) continue // user deleted it — respect that, don't resurrect
    if (hashContent(onDisk) !== record.hash) continue // user edited it — never overwrite

    try {
      await writeFile(path, skill.content, 'utf8')
      const assetHashes = await seedSkillAssets(join(globalDir, name), skill.assets, record.assetHashes ?? {})
      state.skills[name] = {
        version: skill.version,
        hash: hashContent(skill.content),
        ...(skill.assets ? { assetHashes } : {})
      }
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
        // parseFrontmatterSafe never throws on invalid YAML (see frontmatter.ts). It has to not:
        // a skill whose description happens to contain a colon-space used to make gray-matter
        // throw here, and this catch then dropped it from the catalog entirely — a skill that
        // silently doesn't exist is a far worse failure than one with an ugly description.
        const { data } = parseFrontmatterSafe(raw)
        out.push({
          name: String(data.name ?? ent.name),
          description: String(data.description ?? ''),
          scope,
          path: skillPath
        })
      } catch {
        // unreadable or missing SKILL.md — genuinely nothing to list for this directory
      }
    }
  } catch {
    // no dir
  }
  return out
}

export interface ResolvedSkill {
  name: string
  scope: 'project' | 'global'
  path: string
  content: string
}

/** The skills catalog in the system prompt lists skills as `name (scope): description` — it
 *  deliberately does NOT include absolute paths (they're long, noisy, and would bloat the cached
 *  prompt prefix for every turn). read_skill therefore has to accept whatever the model actually
 *  has in front of it: the bare skill *name*, a catalog-style `name (scope)` / `name (scope): desc`
 *  line pasted verbatim, or a real path from list_skills. Previously it only accepted an exact
 *  path, so the first call was always a guess that threw ENOENT, forcing a list_skills round-trip
 *  before every single skill read. */
function parseSkillRef(raw: unknown): { ref: string; scopeHint?: 'project' | 'global' } {
  let ref = String(raw ?? '').trim()
  // Strip wrapping quotes/backticks the model sometimes includes.
  ref = ref.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim()
  // Catalog line shapes: "browser-automation (global)" / "browser-automation (global): How to...".
  const m = /^(.+?)\s*\((project|global)\)\s*(?::[\s\S]*)?$/i.exec(ref)
  if (m) {
    return { ref: m[1].trim(), scopeHint: m[2].toLowerCase() as 'project' | 'global' }
  }
  return { ref }
}

function looksLikePath(ref: string): boolean {
  return isAbsolute(ref) || ref.includes('/') || ref.includes('\\') || /\.md$/i.test(ref)
}

/** Must check isFile(), not just existence: for a ref like `.../skills/browser-automation` the
 *  *directory* itself exists, so an access()-only check would happily return the directory and then
 *  fail to read it as a SKILL.md — defeating the `join(ref, 'SKILL.md')` fallback below. */
async function firstReadableFile(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      const st = await stat(candidate)
      if (st.isFile()) return candidate
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Path-shaped refs: accept the exact file, a skill *directory* (append SKILL.md), and
 *  workspace-/global-relative forms like `.klenny/skills/foo/SKILL.md`. */
async function resolvePathishRef(ref: string): Promise<string | null> {
  const bases: string[] = []
  const ws = getWorkspace()
  if (ws) bases.push(ws)
  bases.push(globalKlennyDir())

  const roots = isAbsolute(ref) ? [ref] : [ref, ...bases.map((b) => join(b, ref))]
  const candidates: string[] = []
  for (const root of roots) {
    candidates.push(root)
    if (!/SKILL\.md$/i.test(root)) candidates.push(join(root, 'SKILL.md'))
  }
  return firstReadableFile(candidates)
}

function scopeForPath(skillPath: string): 'project' | 'global' {
  const globalSkills = resolve(join(globalKlennyDir(), 'skills'))
  const resolved = resolve(skillPath)
  if (resolved === globalSkills || resolved.startsWith(globalSkills + sep)) return 'global'
  return 'project'
}

/** Resolves a skill reference (name, catalog line, or path) to a concrete SKILL.md.
 *  Name matching is case-insensitive and checks the frontmatter `name`, the containing directory
 *  name, and the path itself; a `(scope)` hint from a catalog line is preferred but never required,
 *  and project scope wins over global on an otherwise-ambiguous name (same precedence as
 *  listSkills' ordering). */
export async function resolveSkill(rawRef: unknown): Promise<ResolvedSkill | null> {
  const { ref, scopeHint } = parseSkillRef(rawRef)
  if (!ref) return null

  const skills = await listSkills()
  const needle = ref.toLowerCase()

  const byName = skills.filter(
    (s) =>
      s.name.toLowerCase() === needle ||
      basename(dirname(s.path)).toLowerCase() === needle ||
      s.path.toLowerCase() === needle
  )
  const match = byName.find((s) => s.scope === scopeHint) ?? byName[0]
  if (match) {
    const content = await readSkillBody(match.path)
    if (content !== null) return { name: match.name, scope: match.scope, path: match.path, content }
  }

  if (looksLikePath(ref)) {
    const path = await resolvePathishRef(ref)
    if (path) {
      const content = await readSkillBody(path)
      if (content !== null) {
        const known = skills.find((s) => resolve(s.path) === resolve(path))
        return {
          name: known?.name ?? basename(dirname(path)),
          scope: known?.scope ?? scopeForPath(path),
          path,
          content
        }
      }
    }
  }

  return null
}

async function readSkillBody(skillPath: string): Promise<string | null> {
  try {
    const raw = await readFile(skillPath, 'utf8')
    // Safe parse for the same reason as scanSkillsDir: broken frontmatter must not make an
    // otherwise-fine skill body unreadable via read_skill.
    const { content } = parseFrontmatterSafe(raw)
    return content.trim()
  } catch {
    return null
  }
}

/** Thrown message is deliberately actionable: it lists what IS available so the model can retry
 *  correctly in the same turn instead of needing a separate list_skills call. */
export async function readSkillDetailed(ref: unknown): Promise<ResolvedSkill> {
  const resolved = await resolveSkill(ref)
  if (resolved) return resolved

  const skills = await listSkills()
  const asked = String(ref ?? '').trim()
  if (!skills.length) {
    throw new Error(`No skills are available${asked ? ` (looked for "${asked}")` : ''}.`)
  }
  const available = skills.map((s) => `${s.name} (${s.scope})`).join(', ')
  throw new Error(
    `Skill "${asked}" not found. Available skills: ${available}. Pass the skill's name exactly as listed (no path needed).`
  )
}

export async function readSkill(ref: string): Promise<string> {
  return (await readSkillDetailed(ref)).content
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
  // Must go through stringifyFrontmatter, not string interpolation: `description` is free text
  // from the model, and any YAML metacharacter in it (a colon-space, a leading `#`/`-`/`[`, a
  // newline) would otherwise emit a SKILL.md that can't be parsed back — see frontmatter.ts.
  await writeFile(join(base, 'SKILL.md'), stringifyFrontmatter({ name, description }, body), 'utf8')
}

export function skillsCatalogPrompt(skills: SkillSummary[]): string {
  if (!skills.length) return ''
  const lines = skills.map((s) => `- ${s.name} (${s.scope}): ${s.description}`)
  return `Available skills (call read_skill with the skill's name — e.g. name: "${skills[0].name}" — when relevant; no path or prior list_skills call needed):\n${lines.join('\n')}`
}
