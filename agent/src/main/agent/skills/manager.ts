import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { SkillSummary } from '@shared/types'
import { getWorkspace } from '../../workspace'
import { globalKlennyDir } from '../memory/manager'

export async function listSkills(): Promise<SkillSummary[]> {
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
