import { describe, expect, test } from 'bun:test'
import { getToolDefinitions } from '../src/main/agent/tools/definitions'

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

  test('cross-project read-only tools are available in both plan and agent mode', () => {
    const crossProjectTools = [
      'list_projects',
      'read_other_project_file',
      'grep_other_project',
      'glob_other_project',
      'read_other_project_memory'
    ]
    const planTools = getToolDefinitions('plan').map((t) => t.function.name)
    const agentTools = getToolDefinitions('agent').map((t) => t.function.name)
    for (const name of crossProjectTools) {
      expect(planTools).toContain(name)
      expect(agentTools).toContain(name)
    }
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

  test('assistant tools (Gmail/Discord/scheduler/settings-nav) are present in agent mode', () => {
    const tools = getToolDefinitions('agent').map((t) => t.function.name)
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

  test('hasWorkspace=false (ephemeral Assistant tab / no project open) hides coding-only tools but keeps assistant tools', () => {
    const tools = getToolDefinitions('agent', undefined, false, false).map((t) => t.function.name)
    expect(tools).not.toContain('write_file')
    expect(tools).not.toContain('edit_file')
    expect(tools).not.toContain('multi_edit')
    expect(tools).not.toContain('delete_file')
    expect(tools).not.toContain('run_command')
    expect(tools).not.toContain('codebase_search')
    // read_file/grep/glob resolve against the process-global getWorkspace() singleton, not a
    // per-tab workspace, so they're coding-only too — otherwise an Assistant tab could silently
    // read whatever project happens to be open in another window. See "Coding tools available
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

  test('hasWorkspace=false overrides restrictTo for coding-only tools (a subagent spawned from an Assistant tab cannot be handed file/shell access)', () => {
    const tools = getToolDefinitions('agent', ['read_file', 'gmail_list_messages'], false, false).map((t) => t.function.name)
    expect(tools).toEqual(['gmail_list_messages'])
  })

  test('hasWorkspace=false still respects restrictTo for workspace-independent tools', () => {
    const tools = getToolDefinitions('agent', ['web_search', 'gmail_list_messages'], false, false).map((t) => t.function.name)
    expect(tools).toEqual(['web_search', 'gmail_list_messages'])
  })
})
