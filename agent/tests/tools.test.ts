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
    expect(tools).toContain('run_command')
  })
})
