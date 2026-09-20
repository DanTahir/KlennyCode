// Electron mock first — definitions.ts reaches modules that touch `electron` at import time.
import './testElectronMock'

import { describe, expect, test } from 'bun:test'
import { getToolDefinitions } from '../src/main/agent/tools/definitions'

/**
 * The `tools` array a request ships IS the output of getToolDefinitions, and a provider hashes
 * tool definitions ahead of the system prompt. A cached block is keyed on its whole preceding
 * prefix, so if this array changes mid-conversation every breakpoint in the request misses —
 * including the fixed system block, whose own bp= fingerprint stays byte-identical, which is what
 * made the original occurrence so hard to see (live: v0.2.157 r4, cachedTokens=0 /
 * cacheWriteTokens=53456 on the request right after a checklist was created).
 *
 * The invariant these tests pin: the array may depend only on things fixed for the life of a
 * conversation (mode, tab kind, subagent restriction, settings), never on per-turn conversation
 * state. The positive control at the bottom keeps the suite honest — a test file that only asserts
 * "nothing changes the array" would also pass against a function that ignored all its arguments.
 */
const FULL_GATING = {
  docxAvailableInCoding: true,
  gmailConnected: true,
  gmailReadAllowed: true,
  gmailSendAllowed: true,
  gmailAvailableInCoding: true,
  discordConnected: true,
  discordPostAllowed: true,
  discordAvailableInCoding: true,
  browserAutomationAvailable: true,
  imageGenerationAvailable: true
}

const names = (defs: ReturnType<typeof getToolDefinitions>): string[] => defs.map((t) => t.function.name)

describe('tools-array stability across a conversation (prompt-cache invariant)', () => {
  test('identical inputs produce a byte-identical array', () => {
    const a = JSON.stringify(getToolDefinitions('agent', undefined, false, true, false, FULL_GATING))
    const b = JSON.stringify(getToolDefinitions('agent', undefined, false, true, false, FULL_GATING))
    expect(b).toBe(a)
  })

  test('update_checklist is offered in agent mode even with no checklist in existence', () => {
    // The regression: it used to appear only once TabSession.activeChecklist was set, so the first
    // create_checklist call of a turn grew the tools array and invalidated the entire prefix.
    expect(names(getToolDefinitions('agent'))).toContain('update_checklist')
  })

  test('a legacy trailing "hasActiveChecklist" argument no longer changes anything', () => {
    // Pins the parameter's removal: re-introducing any per-turn gate in that position fails here.
    const loose = getToolDefinitions as unknown as (...args: unknown[]) => ReturnType<typeof getToolDefinitions>
    const withLegacyFalse = JSON.stringify(loose('agent', undefined, false, true, false, FULL_GATING, false))
    const withLegacyTrue = JSON.stringify(loose('agent', undefined, false, true, false, FULL_GATING, true))
    const without = JSON.stringify(getToolDefinitions('agent', undefined, false, true, false, FULL_GATING))
    expect(withLegacyFalse).toBe(without)
    expect(withLegacyTrue).toBe(without)
  })

  test('the same holds for an Assistant tab', () => {
    const loose = getToolDefinitions as unknown as (...args: unknown[]) => ReturnType<typeof getToolDefinitions>
    const gated = JSON.stringify(loose('agent', undefined, false, false, true, FULL_GATING, true))
    const plain = JSON.stringify(getToolDefinitions('agent', undefined, false, false, true, FULL_GATING))
    expect(gated).toBe(plain)
  })

  test('plan mode still never offers update_checklist (constant absence, not state-dependent)', () => {
    const loose = getToolDefinitions as unknown as (...args: unknown[]) => ReturnType<typeof getToolDefinitions>
    expect(names(getToolDefinitions('plan'))).not.toContain('update_checklist')
    expect(names(loose('plan', undefined, false, true, false, FULL_GATING, true))).not.toContain('update_checklist')
  })

  test('positive control: a settings-derived gate DOES still change the array', () => {
    // Settings changes are legitimately allowed to invalidate the prefix (they're rare and
    // user-driven); this asserts the gating machinery is still wired up at all, so the tests above
    // cannot pass vacuously.
    const withImage = names(getToolDefinitions('agent', undefined, false, true, false, { imageGenerationAvailable: true }))
    const withoutImage = names(getToolDefinitions('agent', undefined, false, true, false, { imageGenerationAvailable: false }))
    expect(withImage).toContain('generate_image')
    expect(withoutImage).not.toContain('generate_image')
  })
})
