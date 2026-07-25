import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { SkillSummary } from '@shared/types'
import { getWorkspace } from '../../workspace'
import { globalKlennyDir } from '../../dataDir'
import { BROWSER_AUTOMATION_SKILL_MD } from './bundledSkills'

/** Bundled skills the app ships with, seeded into the global skills dir once, ever, per
 *  install — a real SKILL.md file the user can see, edit, or delete via the Skills panel,
 *  rather than a hardcoded prompt block. Gated on a marker file (not the skill file's own
 *  existence) so a user who deliberately deletes a bundled skill doesn't have it silently
 *  resurrected the next time listSkills() runs — only a brand-new install (no marker yet) seeds
 *  it, matching the one-time nature of SOUL.md's seed but without SOUL.md's "always exists"
 *  assumption (skills are meant to be freely deletable). */
const BUNDLED_SKILLS: Record<string, string> = {
  'browser-automation': BROWSER_AUTOMATION_SKILL_MD
}

function seedMarkerPath(): string {
  return join(globalKlennyDir(), '.bundled-skills-seeded')
}

let seedAttempted = false

async function seedBundledSkills(): Promise<void> {
  if (seedAttempted) return
  seedAttempted = true
  try {
    await access(seedMarkerPath())
    return // already seeded on a previous run (or previous app version)
  } catch {
    // marker absent — first time seeding
  }
  const globalDir = join(globalKlennyDir(), 'skills')
  for (const [name, content] of Object.entries(BUNDLED_SKILLS)) {
    const path = join(globalDir, name, 'SKILL.md')
    try {
      await mkdir(join(globalDir, name), { recursive: true })
      await writeFile(path, content, 'utf8')
    } catch {
      // best-effort seed only — a failure here just means the skill isn't offered this run
    }
  }
  try {
    await mkdir(globalKlennyDir(), { recursive: true })
    await writeFile(seedMarkerPath(), new Date().toISOString(), 'utf8')
  } catch {
    // if the marker itself fails to write, seedAttempted (in-memory) still prevents retrying
    // within this process — worst case it re-seeds once on the next app launch.
  }
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
  const base =
    scope === 'global'
      ? join(globalKlennyDir(), 'skills', name)
      : join(getWorkspace() ?? '.', '.klenny', 'skills', name)
  await mkdir(base, { recursive: true })
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\n---\n\n`
  await writeFile(join(base, 'SKILL.md'), frontmatter + body.trim() + '\n', 'utf8')
}

export function skillsCatalogPrompt(skills: SkillSummary[]): string {
  if (!skills.length) return ''
  const lines = skills.map((s) => `- ${s.name} (${s.scope}): ${s.description}`)
  return `Available skills (call read_skill when relevant):\n${lines.join('\n')}`
}
