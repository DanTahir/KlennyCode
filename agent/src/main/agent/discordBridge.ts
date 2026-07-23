/**
 * Bridges an inbound Discord message (DM, @mention, or "!klenny" prefix command — see
 * integrations/discord.ts) into a fully unattended subagent run and returns the reply text to
 * post back. Kept in agent/ (rather than integrations/discord.ts) so it can import from
 * orchestrator.ts without discord.ts needing to import orchestrator.ts itself (that circular
 * import is instead avoided the other way: discord.ts exposes setInboundCommandHandler(), which
 * main/index.ts wires to this function at startup).
 *
 * Natural-language project selection for requests like "review project X" reuses the existing
 * read-only cross-project reference tools (list_projects, read_other_project_file, etc.) rather
 * than opening the named project as the active workspace — per the plan, ambiguous project name
 * matches should make the subagent ask for clarification in the reply rather than guessing.
 */
import { nanoid } from 'nanoid'
import type { ChatMessage, TabSession } from '@shared/types'
import { getApiKey, loadSettings } from '../settings'
import { runDiscordSubagent } from './orchestrator'

export async function runInboundDiscordCommand(text: string): Promise<string> {
  const apiKey = await getApiKey()
  if (!apiKey) return "I can't help right now \u2014 no OpenRouter API key is set in Klenny Code's Settings."

  const settings = await loadSettings()
  const subTab: TabSession = {
    id: `discord_${nanoid()}`,
    title: 'Discord command',
    mode: 'agent',
    model: settings.subagentModel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    kind: 'assistant',
    messages: [
      {
        id: nanoid(),
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `[This message was sent via Discord and your reply will be posted back there \u2014 keep it reasonably concise. If it asks you to look at or review a project by name and list_projects returns zero or more than one plausible match, ask a clarifying question in your reply instead of guessing which project was meant.]\n\n${text}`
          }
        ],
        createdAt: Date.now()
      } as ChatMessage
    ],
    totalCostUsd: 0,
    totalSavingsUsd: 0
  }

  return runDiscordSubagent(subTab, apiKey, settings.subagentModel)
}
