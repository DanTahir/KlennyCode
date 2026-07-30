import { describe, expect, test } from 'bun:test'
import './testElectronMock' // registers a shared electron mock — see that file for why this matters; system-prompt.ts and plan/manager.ts transitively import electron (via workspace.ts/settings.ts et al.), so they must be loaded dynamically below, after this mock is registered

import { buildChecklist } from '../src/main/agent/orchestrator/checklist'

describe('buildChecklist (shared helper behind both approvePlan() and create_checklist)', () => {
  test('builds a ChatMessage with a checklist block and a matching activeChecklist', () => {
    const { message, activeChecklist } = buildChecklist('My Task', ['step one', 'step two'])
    expect(message.role).toBe('assistant')
    expect(message.blocks).toHaveLength(1)
    expect(message.blocks[0]).toMatchObject({ type: 'checklist', title: 'My Task' })
    expect(activeChecklist.title).toBe('My Task')
    expect(activeChecklist.messageId).toBe(message.id)
    expect(activeChecklist.items).toHaveLength(2)
    expect(activeChecklist.items[0]).toEqual({ id: 'item-1', text: 'step one', done: false })
    expect(activeChecklist.items[1]).toEqual({ id: 'item-2', text: 'step two', done: false })
  })

  test('every item starts not-done and with no evidence', () => {
    const { activeChecklist } = buildChecklist('T', ['a', 'b', 'c'])
    for (const it of activeChecklist.items) {
      expect(it.done).toBe(false)
      expect(it.evidence).toBeUndefined()
    }
  })
})

describe('buildCurrentTimeNote — checklist rendering, evidence, and post-compaction skepticism', () => {
  test('with no activeChecklist, mentions no checklist at all', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote(undefined, undefined)
    expect(note).not.toContain('checklist')
  })

  test('renders an active checklist with done/not-done markers', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote(undefined, {
      title: 'Ship the feature',
      items: [
        { id: 'item-1', text: 'write code', done: true },
        { id: 'item-2', text: 'write tests', done: false }
      ]
    })
    expect(note).toContain('Ship the feature')
    expect(note).toContain('1. [x] write code')
    expect(note).toContain('2. [ ] write tests')
  })

  test('renders per-item evidence when present, and omits the "verified" suffix when absent', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote(undefined, {
      title: 'T',
      items: [
        { id: 'item-1', text: 'did a thing', done: true, evidence: 'ran tests, 5 passed' },
        { id: 'item-2', text: 'no evidence here', done: true }
      ]
    })
    expect(note).toContain('1. [x] did a thing — verified: ran tests, 5 passed')
    expect(note).toContain('2. [x] no evidence here')
    expect(note).not.toContain('no evidence here — verified')
  })

  test('justCompacted=true adds a skepticism note only when at least one item is already done', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const noneDone = await buildCurrentTimeNote(
      undefined,
      { title: 'T', items: [{ id: 'item-1', text: 'a', done: false }] },
      true
    )
    expect(noneDone).not.toContain('self-reported')

    const someDone = await buildCurrentTimeNote(
      undefined,
      { title: 'T', items: [{ id: 'item-1', text: 'a', done: true }] },
      true
    )
    expect(someDone).toContain('self-reported')
    expect(someDone).toContain('never independently re-verified')
  })

  test('justCompacted=false (or omitted) never adds the skepticism note, even with done items', async () => {
    const { buildCurrentTimeNote } = await import('../src/main/agent/orchestrator/system-prompt')
    const note = await buildCurrentTimeNote(undefined, { title: 'T', items: [{ id: 'item-1', text: 'a', done: true }] })
    expect(note).not.toContain('self-reported')

    const noteFalse = await buildCurrentTimeNote(
      undefined,
      { title: 'T', items: [{ id: 'item-1', text: 'a', done: true }] },
      false
    )
    expect(noteFalse).not.toContain('self-reported')
  })
})

describe('plan/manager prompt builders — checklist honesty + trailing-note explainer guardrails', () => {
  test('buildAgentModePrompt includes the checklist-honesty guardrail', async () => {
    const { buildAgentModePrompt } = await import('../src/main/agent/plan/manager')
    const prompt = buildAgentModePrompt('')
    expect(prompt).toContain('Checklist honesty')
    expect(prompt).toContain('evidence')
    expect(prompt).toContain('create_checklist')
  })

  test('buildAgentModePrompt includes the trailing-note explainer', async () => {
    const { buildAgentModePrompt } = await import('../src/main/agent/plan/manager')
    const prompt = buildAgentModePrompt('')
    expect(prompt).toContain('System-message structure')
    expect(prompt).toContain('not a discrepancy to flag')
  })

  test('buildPlanModePrompt also includes both new guardrails (update_checklist is usable in plan mode too)', async () => {
    const { buildPlanModePrompt } = await import('../src/main/agent/plan/manager')
    const prompt = buildPlanModePrompt('')
    expect(prompt).toContain('Checklist honesty')
    expect(prompt).toContain('System-message structure')
  })
})
