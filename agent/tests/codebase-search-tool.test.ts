import { describe, expect, test } from 'bun:test'
import { getToolDefinitions } from '../src/main/agent/tools/definitions'

describe('codebase_search tool gating', () => {
  test('hidden from agent mode when codebaseSearchAvailable is false (default)', () => {
    const tools = getToolDefinitions('agent').map((t) => t.function.name)
    expect(tools).not.toContain('codebase_search')
  })

  test('hidden from plan mode when codebaseSearchAvailable is false', () => {
    const tools = getToolDefinitions('plan').map((t) => t.function.name)
    expect(tools).not.toContain('codebase_search')
  })

  test('hidden when codebaseSearchAvailable is explicitly false', () => {
    const tools = getToolDefinitions('agent', undefined, false).map((t) => t.function.name)
    expect(tools).not.toContain('codebase_search')
  })

  test('present in agent mode when codebaseSearchAvailable is true', () => {
    const tools = getToolDefinitions('agent', undefined, true).map((t) => t.function.name)
    expect(tools).toContain('codebase_search')
  })

  test('present in plan mode when codebaseSearchAvailable is true', () => {
    const tools = getToolDefinitions('plan', undefined, true).map((t) => t.function.name)
    expect(tools).toContain('codebase_search')
  })

  test('restrictTo still applies even when codebaseSearchAvailable is true', () => {
    const tools = getToolDefinitions('agent', ['read_file', 'grep'], true).map((t) => t.function.name)
    expect(tools).not.toContain('codebase_search')
  })

  test("restrictTo 'all' + codebaseSearchAvailable together keep codebase_search", () => {
    const tools = getToolDefinitions('agent', 'all', true).map((t) => t.function.name)
    expect(tools).toContain('codebase_search')
  })

  test('codebase_search parameters accept query and optional topK', () => {
    const tool = getToolDefinitions('agent', undefined, true).find((t) => t.function.name === 'codebase_search')
    expect(tool).toBeDefined()
    expect(tool?.function.parameters).toMatchObject({
      type: 'object',
      required: ['query']
    })
  })
})
