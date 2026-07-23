import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { SubagentTypeSummary, ToolName } from '@shared/types'
import { getWorkspace } from '../../workspace'
import { globalKlennyDir } from '../../dataDir'

const BUILT_IN: SubagentTypeSummary[] = [
  {
    name: 'general-purpose',
    description: 'General-purpose agent for multi-step tasks and research.',
    tools: 'all',
    builtIn: true
  },
  {
    name: 'explore',
    description: 'Fast read-only codebase exploration. Use for searching files and understanding structure.',
    tools: [
      'read_file',
      'grep',
      'glob',
      'web_search',
      'fetch_url',
      'read_memory',
      'codebase_search',
      'list_projects',
      'read_other_project_file',
      'grep_other_project',
      'glob_other_project',
      'read_other_project_memory'
    ],
    builtIn: true
  },
  {
    name: 'plan-checker',
    description: 'Review a plan for gaps, risks, and missing steps before implementation.',
    tools: [
      'read_file',
      'grep',
      'glob',
      'web_search',
      'fetch_url',
      'read_memory',
      'codebase_search',
      'list_projects',
      'read_other_project_file',
      'grep_other_project',
      'glob_other_project',
      'read_other_project_memory'
    ],
    builtIn: true
  }
]

export async function listSubagentTypes(): Promise<SubagentTypeSummary[]> {
  const custom: SubagentTypeSummary[] = []
  const ws = getWorkspace()
  if (ws) custom.push(...(await scanAgents(join(ws, '.klenny', 'agents'), 'project')))
  custom.push(...(await scanAgents(join(globalKlennyDir(), 'agents'), 'global')))
  return [...BUILT_IN, ...custom]
}

async function scanAgents(dir: string, scope: 'project' | 'global'): Promise<SubagentTypeSummary[]> {
  const out: SubagentTypeSummary[] = []
  try {
    const files = await readdir(dir)
    for (const file of files) {
      if (!file.endsWith('.md')) continue
      const path = join(dir, file)
      const raw = await readFile(path, 'utf8')
      const { data } = matter(raw)
      const tools = data.tools === 'all' ? 'all' : ((data.tools as ToolName[]) ?? ['read_file', 'grep', 'glob'])
      out.push({
        name: String(data.name ?? file.replace(/\.md$/, '')),
        description: String(data.description ?? ''),
        tools,
        model: data.model ? String(data.model) : undefined,
        builtIn: false,
        scope,
        path
      })
    }
  } catch {
    // none
  }
  return out
}

export async function writeSubagentType(
  name: string,
  scope: 'project' | 'global',
  description: string,
  tools: string[] | 'all',
  model: string | undefined,
  body: string
): Promise<void> {
  const dir =
    scope === 'global' ? join(globalKlennyDir(), 'agents') : join(getWorkspace() ?? '.', '.klenny', 'agents')
  await mkdir(dir, { recursive: true })
  const toolsYaml = tools === 'all' ? 'all' : `[${(tools as string[]).map((t) => `"${t}"`).join(', ')}]`
  const modelLine = model ? `model: ${model}\n` : ''
  const frontmatter = `---\nname: ${name}\ndescription: ${description}\ntools: ${toolsYaml}\n${modelLine}---\n\n`
  await writeFile(join(dir, `${name}.md`), frontmatter + body.trim() + '\n', 'utf8')
}

export function getBuiltInSubagent(name: string): SubagentTypeSummary | undefined {
  return BUILT_IN.find((b) => b.name === name)
}

export async function getSubagentType(name: string): Promise<SubagentTypeSummary | undefined> {
  const all = await listSubagentTypes()
  return all.find((a) => a.name === name)
}

export function subagentsCatalog(types: SubagentTypeSummary[]): string {
  return types.map((t) => `- ${t.name}: ${t.description}`).join('\n')
}
