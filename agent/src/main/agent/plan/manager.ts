import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { PlanArtifact } from '@shared/types'
import { getWorkspace } from '../../workspace'

function plansDir(): string | null {
  const ws = getWorkspace()
  if (!ws) return null
  return join(ws, '.klenny', 'plans')
}

export async function savePlan(slug: string, title: string, markdown: string): Promise<PlanArtifact> {
  const dir = plansDir()
  if (!dir) throw new Error('No workspace open')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${slug}.plan.md`)
  const content = `---\ntitle: ${title}\nslug: ${slug}\ncreatedAt: ${Date.now()}\n---\n\n${markdown}`
  await writeFile(path, content, 'utf8')
  return { slug, title, markdown, path, createdAt: Date.now() }
}

export async function listPlans(): Promise<PlanArtifact[]> {
  const dir = plansDir()
  if (!dir) return []
  try {
    const files = await readdir(dir)
    const out: PlanArtifact[] = []
    for (const f of files) {
      if (!f.endsWith('.plan.md')) continue
      const slug = f.replace(/\.plan\.md$/, '')
      const plan = await readPlan(slug)
      if (plan) out.push(plan)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}

export async function readPlan(slug: string): Promise<PlanArtifact | null> {
  const dir = plansDir()
  if (!dir) return null
  try {
    const path = join(dir, `${slug}.plan.md`)
    const raw = await readFile(path, 'utf8')
    const titleMatch = raw.match(/^title:\s*(.+)$/m)
    const createdMatch = raw.match(/^createdAt:\s*(\d+)$/m)
    const body = raw.replace(/^---[\s\S]*?---\n*/, '')
    return {
      slug,
      title: titleMatch?.[1] ?? slug,
      markdown: body.trim(),
      path,
      createdAt: Number(createdMatch?.[1] ?? Date.now())
    }
  } catch {
    return null
  }
}

export const PLAN_MODE_PROMPT = `You are in PLAN MODE. You may only use read-only tools. Do NOT edit, write, delete files, or run shell commands.

Before researching or writing a plan, use ask_question to clarify ambiguous requirements. Ask 1-2 critical questions at a time.

When ready, produce a detailed plan in markdown (with mermaid diagrams where helpful) and call save_plan with a slug and title.`

export const AGENT_MODE_PROMPT = `You are Klenny, a capable coding agent. Use tools to accomplish tasks. When requirements are ambiguous, use ask_question before making irreversible changes.

File changes: always use read_file, then edit_file or write_file. Never use run_command with sed, echo, node -e, python -c, or similar to edit files — those fail on Windows and are blocked. For renames or global substitutions within one file, use edit_file with replace_all: true.

Prefer small, focused edits. Use grep/glob to explore. Spawn subagents via task for parallel exploration.`
