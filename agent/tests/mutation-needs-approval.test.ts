import { describe, expect, test } from 'bun:test'
import './testElectronMock' // loop.ts transitively imports electron — must be loaded dynamically below, after this mock is registered

// Regression test: parallel_write used to queue an approval card per job unconditionally, even on
// a tab set to auto-approve, because its approve() callback (run from inside dispatchTool) never
// consulted the tab's approval mode. It now shares mutationNeedsApproval() with executeTool's
// generic mutating-tool gate, so both must give the same answer for every mode.
describe('mutationNeedsApproval', () => {
  test('auto mode never needs approval — including parallel_write', async () => {
    const { mutationNeedsApproval } = await import('../src/main/agent/orchestrator/loop')
    for (const tool of ['parallel_write', 'write_file', 'multi_write', 'multi_edit', 'run_command']) {
      expect(mutationNeedsApproval('auto', tool)).toBe(false)
    }
  })

  test('command mode auto-applies file writes (parallel_write included) but reviews run_command', async () => {
    const { mutationNeedsApproval } = await import('../src/main/agent/orchestrator/loop')
    expect(mutationNeedsApproval('command', 'parallel_write')).toBe(false)
    expect(mutationNeedsApproval('command', 'write_file')).toBe(false)
    expect(mutationNeedsApproval('command', 'run_command')).toBe(true)
  })

  test('manual mode always needs approval', async () => {
    const { mutationNeedsApproval } = await import('../src/main/agent/orchestrator/loop')
    for (const tool of ['parallel_write', 'write_file', 'multi_write', 'run_command']) {
      expect(mutationNeedsApproval('manual', tool)).toBe(true)
    }
  })
})
