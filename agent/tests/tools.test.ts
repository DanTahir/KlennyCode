import { describe, expect, test } from 'bun:test'
import { getToolDefinitions, type ToolGatingOptions } from '../src/main/agent/tools/definitions'

// Fully-open gating fixture — connected + all relevant permissions allowed + available in
// coding — used by tests that only care about *other* dimensions (mode/restrictTo/hasWorkspace/
// isAssistant) and don't want docx/Gmail/Discord's own opt-in gates to interfere.
const OPEN_GATING: ToolGatingOptions = {
  docxAvailableInCoding: true,
  gmailConnected: true,
  gmailReadAllowed: true,
  gmailSendAllowed: true,
  gmailAvailableInCoding: true,
  discordConnected: true,
  discordPostAllowed: true,
  discordAvailableInCoding: true
}

describe('tool definitions', () => {
  test('plan mode excludes mutating tools', () => {
    const tools = getToolDefinitions('plan').map((t) => t.function.name)
    expect(tools).toContain('ask_question')
    expect(tools).toContain('read_file')
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('run_command')
  })

  test('agent mode includes mutating tools', () => {
    const tools = getToolDefinitions('agent').map((t) => t.function.name)
    expect(tools).toContain('write_file')
    expect(tools).toContain('edit_file')
    expect(tools).toContain('multi_edit')
    expect(tools).toContain('run_command')
  })

  test('plan mode excludes multi_edit (batch editing is a mutating tool)', () => {
    const tools = getToolDefinitions('plan').map((t) => t.function.name)
    expect(tools).not.toContain('multi_edit')
  })

  test('read_memory is available (read-only) in both plan and agent mode', () => {
    expect(getToolDefinitions('plan').map((t) => t.function.name)).toContain('read_memory')
    expect(getToolDefinitions('agent').map((t) => t.function.name)).toContain('read_memory')
  })

  test("read_memory's schema accepts scope 'assistant' and no longer requires topic (assistant scope needs no topic)", () => {
    const def = getToolDefinitions('agent').find((t) => t.function.name === 'read_memory')
    expect(def).toBeDefined()
    const params = def!.function.parameters as { properties: { scope: { enum: string[] } }; required: string[] }
    expect(params.properties.scope.enum).toContain('assistant')
    expect(params.properties.scope.enum).toContain('project')
    expect(params.properties.scope.enum).toContain('global')
    expect(params.required).toEqual(['scope'])
  })

  test('list_projects and list_memory are available in both plan and agent mode', () => {
    const names = ['list_projects', 'list_memory']
    const planTools = getToolDefinitions('plan').map((t) => t.function.name)
    const agentTools = getToolDefinitions('agent').map((t) => t.function.name)
    for (const name of names) {
      expect(planTools).toContain(name)
      expect(agentTools).toContain(name)
    }
  })

  test('read_other_project_file/grep_other_project/glob_other_project/read_other_project_memory no longer exist as tools', () => {
    const planTools = getToolDefinitions('plan').map((t) => t.function.name)
    const agentTools = getToolDefinitions('agent').map((t) => t.function.name)
    for (const name of ['read_other_project_file', 'grep_other_project', 'glob_other_project', 'read_other_project_memory']) {
      expect(planTools).not.toContain(name)
      expect(agentTools).not.toContain(name)
    }
  })

  test("read_memory's schema accepts an optional `project` argument for cross-project reads", () => {
    const def = getToolDefinitions('agent').find((t) => t.function.name === 'read_memory')
    expect(def).toBeDefined()
    const params = def!.function.parameters as { properties: Record<string, unknown> }
    expect(params.properties.project).toBeDefined()
  })

  test('restrictTo narrows the tool set for restricted subagents', () => {
    const tools = getToolDefinitions('agent', ['read_file', 'grep', 'glob']).map((t) => t.function.name)
    expect(tools).toContain('read_file')
    expect(tools).toContain('grep')
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('task')
    expect(tools).not.toContain('ask_question')
  })

  test("restrictTo 'all' keeps the full mode-appropriate tool set", () => {
    const tools = getToolDefinitions('agent', 'all').map((t) => t.function.name)
    expect(tools).toContain('write_file')
    expect(tools).toContain('task')
  })

  test('assistant tools (Gmail/Discord/scheduler/settings-nav) are present in agent mode when Gmail/Discord are connected+permitted', () => {
    const tools = getToolDefinitions('agent', undefined, false, true, false, OPEN_GATING).map((t) => t.function.name)
    expect(tools).toContain('open_settings_panel')
    expect(tools).toContain('gmail_list_messages')
    expect(tools).toContain('gmail_get_message')
    expect(tools).toContain('gmail_send_message')
    expect(tools).toContain('discord_post_message')
    expect(tools).toContain('scheduler_create_task')
    expect(tools).toContain('scheduler_list_tasks')
    expect(tools).toContain('scheduler_update_task')
    expect(tools).toContain('scheduler_delete_task')
  })

  test('hasWorkspace=false on a project-kind tab (no project open, isAssistant not set) hides file tools and coding-only tools but keeps assistant tools', () => {
    const tools = getToolDefinitions('agent', undefined, false, false, false, OPEN_GATING).map((t) => t.function.name)
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('edit_file')
    expect(tools).not.toContain('multi_edit')
    expect(tools).not.toContain('delete_file')
    expect(tools).not.toContain('run_command')
    expect(tools).not.toContain('codebase_search')
    // On a project-kind tab, read_file/write_file/etc. and grep/glob have no root to resolve
    // relative paths or sandbox mutations against once the workspace is gone — unlike an
    // Assistant tab, there's no documentsDirectory fallback here. See "Coding tools available
    // inside an Assistant-kind tab" investigation/fix.
    expect(tools).not.toContain('read_file')
    expect(tools).not.toContain('grep')
    expect(tools).not.toContain('glob')
    // genuinely workspace-independent tools remain available
    expect(tools).toContain('web_search')
    expect(tools).toContain('fetch_url')
    expect(tools).toContain('read_memory')
    expect(tools).toContain('write_memory')
    expect(tools).toContain('gmail_list_messages')
    expect(tools).toContain('discord_post_message')
    expect(tools).toContain('scheduler_create_task')
    expect(tools).toContain('open_settings_panel')
  })

  test('hasWorkspace defaults to true (coding tools still available) when the parameter is omitted', () => {
    const tools = getToolDefinitions('agent').map((t) => t.function.name)
    expect(tools).toContain('write_file')
    expect(tools).toContain('run_command')
    expect(tools).toContain('read_file')
  })

  test('hasWorkspace=false overrides restrictTo for file/coding-only tools on a project-kind tab', () => {
    const tools = getToolDefinitions('agent', ['read_file', 'gmail_list_messages'], false, false, false, OPEN_GATING).map((t) => t.function.name)
    expect(tools).toEqual(['gmail_list_messages'])
  })

  test('hasWorkspace=false still respects restrictTo for workspace-independent tools', () => {
    const tools = getToolDefinitions('agent', ['web_search', 'gmail_list_messages'], false, false, false, OPEN_GATING).map(
      (t) => t.function.name
    )
    expect(tools).toEqual(['web_search', 'gmail_list_messages'])
  })

  test('isAssistant=true offers exactly ASSISTANT_TOOLS regardless of mode/hasWorkspace — file tools included, coding-only tools excluded', () => {
    const tools = getToolDefinitions('agent', undefined, false, false, true, OPEN_GATING).map((t) => t.function.name)
    // File tools ARE available on an Assistant tab now (scoped to documentsDirectory by the
    // caller — see documentsDir.ts), unlike a workspace-less project tab.
    expect(tools).toContain('read_file')
    expect(tools).toContain('write_file')
    expect(tools).toContain('edit_file')
    expect(tools).toContain('multi_edit')
    expect(tools).toContain('delete_file')
    expect(tools).toContain('grep')
    expect(tools).toContain('glob')
    // Still never available on an Assistant tab: truly workspace-dependent tools, and save_plan.
    expect(tools).not.toContain('run_command')
    expect(tools).not.toContain('read_terminal')
    expect(tools).not.toContain('codebase_search')
    expect(tools).not.toContain('save_plan')
    // Assistant-compatible tools remain available.
    expect(tools).toContain('web_search')
    expect(tools).toContain('gmail_list_messages')
    expect(tools).toContain('task')
  })

  test('isAssistant=true ignores hasWorkspace=true too — still no run_command/codebase_search', () => {
    const tools = getToolDefinitions('agent', undefined, true, true, true, OPEN_GATING).map((t) => t.function.name)
    expect(tools).not.toContain('run_command')
    expect(tools).not.toContain('codebase_search')
    expect(tools).toContain('read_file')
  })

  test('isAssistant=true still respects restrictTo (subagent spawned from an Assistant tab)', () => {
    const tools = getToolDefinitions('agent', ['read_file', 'gmail_list_messages'], false, false, true, OPEN_GATING).map(
      (t) => t.function.name
    )
    expect(tools).toEqual(['read_file', 'gmail_list_messages'])
  })
})

describe('docx/Gmail/Discord tool gating (default-closed, per-option opt-in)', () => {
  test('docx tools are hidden on a project-kind tab by default (docxAvailableInCoding defaults to false/absent)', () => {
    const tools = getToolDefinitions('agent').map((t) => t.function.name)
    expect(tools).not.toContain('read_docx')
    expect(tools).not.toContain('write_docx')
    expect(tools).not.toContain('edit_docx')
  })

  test('docx tools appear on a project-kind tab once docxAvailableInCoding is true', () => {
    const tools = getToolDefinitions('agent', undefined, false, true, false, { docxAvailableInCoding: true }).map(
      (t) => t.function.name
    )
    expect(tools).toContain('read_docx')
    expect(tools).toContain('write_docx')
    expect(tools).toContain('edit_docx')
  })

  test('docx tools are always available on the Assistant tab regardless of docxAvailableInCoding', () => {
    const tools = getToolDefinitions('agent', undefined, false, false, true, { docxAvailableInCoding: false }).map(
      (t) => t.function.name
    )
    expect(tools).toContain('read_docx')
    expect(tools).toContain('write_docx')
    expect(tools).toContain('edit_docx')
  })

  test('docx tools are hidden on a project-kind tab with no workspace open even if docxAvailableInCoding is true', () => {
    const tools = getToolDefinitions('agent', undefined, false, false, false, { docxAvailableInCoding: true }).map(
      (t) => t.function.name
    )
    expect(tools).not.toContain('read_docx')
  })

  test('gmail/discord tools are hidden everywhere (including Assistant) by default — no gating options passed', () => {
    const agentTools = getToolDefinitions('agent').map((t) => t.function.name)
    const assistantTools = getToolDefinitions('agent', undefined, false, false, true).map((t) => t.function.name)
    for (const name of ['gmail_list_messages', 'gmail_get_message', 'gmail_send_message', 'discord_post_message']) {
      expect(agentTools).not.toContain(name)
      expect(assistantTools).not.toContain(name)
    }
  })

  test('gmail read tools require both connection and gmail.read permission, even on the Assistant tab', () => {
    const connectedOnly = getToolDefinitions('agent', undefined, false, false, true, {
      gmailConnected: true,
      gmailReadAllowed: false
    }).map((t) => t.function.name)
    expect(connectedOnly).not.toContain('gmail_list_messages')

    const permittedOnly = getToolDefinitions('agent', undefined, false, false, true, {
      gmailConnected: false,
      gmailReadAllowed: true
    }).map((t) => t.function.name)
    expect(permittedOnly).not.toContain('gmail_list_messages')

    const both = getToolDefinitions('agent', undefined, false, false, true, {
      gmailConnected: true,
      gmailReadAllowed: true
    }).map((t) => t.function.name)
    expect(both).toContain('gmail_list_messages')
    expect(both).toContain('gmail_get_message')
    // send still requires gmail.send separately
    expect(both).not.toContain('gmail_send_message')
  })

  test('gmail_send_message requires gmailSendAllowed specifically, independent of gmailReadAllowed', () => {
    const tools = getToolDefinitions('agent', undefined, false, false, true, {
      gmailConnected: true,
      gmailReadAllowed: true,
      gmailSendAllowed: true
    }).map((t) => t.function.name)
    expect(tools).toContain('gmail_send_message')
  })

  test('gmail tools connected+permitted are still hidden on a project-kind tab unless gmailAvailableInCoding is true', () => {
    const withoutCodingFlag = getToolDefinitions('agent', undefined, false, true, false, {
      gmailConnected: true,
      gmailReadAllowed: true,
      gmailSendAllowed: true
    }).map((t) => t.function.name)
    expect(withoutCodingFlag).not.toContain('gmail_list_messages')
    expect(withoutCodingFlag).not.toContain('gmail_send_message')

    const withCodingFlag = getToolDefinitions('agent', undefined, false, true, false, {
      gmailConnected: true,
      gmailReadAllowed: true,
      gmailSendAllowed: true,
      gmailAvailableInCoding: true
    }).map((t) => t.function.name)
    expect(withCodingFlag).toContain('gmail_list_messages')
    expect(withCodingFlag).toContain('gmail_send_message')
  })

  test('discord_post_message requires both connection and discord.post permission, even on the Assistant tab', () => {
    const notConnected = getToolDefinitions('agent', undefined, false, false, true, {
      discordConnected: false,
      discordPostAllowed: true
    }).map((t) => t.function.name)
    expect(notConnected).not.toContain('discord_post_message')

    const notPermitted = getToolDefinitions('agent', undefined, false, false, true, {
      discordConnected: true,
      discordPostAllowed: false
    }).map((t) => t.function.name)
    expect(notPermitted).not.toContain('discord_post_message')

    const both = getToolDefinitions('agent', undefined, false, false, true, {
      discordConnected: true,
      discordPostAllowed: true
    }).map((t) => t.function.name)
    expect(both).toContain('discord_post_message')
  })

  test('discord_post_message connected+permitted is still hidden on a project-kind tab unless discordAvailableInCoding is true', () => {
    const withoutCodingFlag = getToolDefinitions('agent', undefined, false, true, false, {
      discordConnected: true,
      discordPostAllowed: true
    }).map((t) => t.function.name)
    expect(withoutCodingFlag).not.toContain('discord_post_message')

    const withCodingFlag = getToolDefinitions('agent', undefined, false, true, false, {
      discordConnected: true,
      discordPostAllowed: true,
      discordAvailableInCoding: true
    }).map((t) => t.function.name)
    expect(withCodingFlag).toContain('discord_post_message')
  })

  test('browser automation is never gated by docx/Gmail/Discord options — stays available on a project tab with no gating passed', () => {
    const agentTools = getToolDefinitions('agent').map((t) => t.function.name)
    expect(agentTools).toContain('browser')
  })
})
