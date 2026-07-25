import { describe, expect, test } from 'bun:test'

// tools/index.ts was split into file-ops.ts / search.ts / web.ts / shell.ts (see that file's
// header comment), with index.ts reduced to a barrel. This test locks in that the barrel still
// re-exports every tool implementation function it did before the split, so a future edit can't
// silently drop a tool group during re-aggregation.
describe('tools/index.ts barrel completeness', () => {
  test('re-exports every file-ops function', async () => {
    const mod = await import('../src/main/agent/tools/index')
    expect(typeof mod.resolveWorkspacePath).toBe('function')
    expect(typeof mod.readFileTool).toBe('function')
    expect(typeof mod.writeFileTool).toBe('function')
    expect(typeof mod.editFileTool).toBe('function')
    expect(typeof mod.multiEditFileTool).toBe('function')
    expect(typeof mod.previewMultiEdit).toBe('function')
    expect(typeof mod.deleteFileTool).toBe('function')
  })

  test('re-exports every search function', async () => {
    const mod = await import('../src/main/agent/tools/index')
    expect(typeof mod.grepTool).toBe('function')
    expect(typeof mod.globTool).toBe('function')
  })

  test('re-exports every web function', async () => {
    const mod = await import('../src/main/agent/tools/index')
    expect(typeof mod.webSearchTool).toBe('function')
    expect(typeof mod.fetchUrlTool).toBe('function')
  })

  test('re-exports every shell function', async () => {
    const mod = await import('../src/main/agent/tools/index')
    expect(typeof mod.runCommandTool).toBe('function')
    expect(typeof mod.killBackgroundProcess).toBe('function')
    expect(typeof mod.runProcess).toBe('function')
  })

  test('re-exports the READ_ONLY_TOOLS / MUTATING_TOOLS catalogs from @shared/types', async () => {
    const mod = await import('../src/main/agent/tools/index')
    expect(Array.isArray(mod.READ_ONLY_TOOLS)).toBe(true)
    expect(mod.READ_ONLY_TOOLS.length).toBeGreaterThan(0)
    expect(Array.isArray(mod.MUTATING_TOOLS)).toBe(true)
    expect(mod.MUTATING_TOOLS).toContain('write_file')
    expect(mod.MUTATING_TOOLS).toContain('run_command')
  })
})
