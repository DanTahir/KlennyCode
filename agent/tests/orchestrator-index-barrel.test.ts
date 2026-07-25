import { describe, expect, test } from 'bun:test'
import './testElectronMock' // registers a shared electron mock — see that file for why this matters; orchestrator/index.ts transitively imports electron (BrowserWindow/Notification) via loop.ts and turn-lifecycle.ts

// orchestrator.ts was split into state.ts / approval-previews.ts / system-prompt.ts / loop.ts /
// turn-lifecycle.ts / scheduled-and-discord.ts (see orchestrator/index.ts's header comment), with
// index.ts reduced to a barrel. This test locks in that the barrel still re-exports every public
// function it did before the split, so a future edit can't silently drop one during re-aggregation
// — the three real consumers (ipc.ts, main/index.ts, discordBridge.ts) all import from this barrel.
describe('orchestrator/index.ts barrel completeness', () => {
  test('re-exports every turn-lifecycle function', async () => {
    const mod = await import('../src/main/agent/orchestrator/index')
    expect(typeof mod.runUserTurn).toBe('function')
    expect(typeof mod.continueTurn).toBe('function')
    expect(typeof mod.stopGeneration).toBe('function')
    expect(typeof mod.resolveQuestion).toBe('function')
    expect(typeof mod.clearTabState).toBe('function')
    expect(typeof mod.getPendingQuestions).toBe('function')
  })

  test('re-exports every scheduled-and-discord function', async () => {
    const mod = await import('../src/main/agent/orchestrator/index')
    expect(typeof mod.runScheduledTask).toBe('function')
    expect(typeof mod.runDiscordSubagent).toBe('function')
  })
})
