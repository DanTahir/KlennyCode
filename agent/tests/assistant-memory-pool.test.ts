import { describe, expect, test } from 'bun:test'
import {
  budgetTokensFor,
  enforceRollupCeiling,
  estimateTokens,
  formatDigest,
  formatRelativeTime,
  ROLLUP_TOKEN_CEILING,
  selectCompactionPlan,
  sortSlotsByRecency
} from '../src/main/agent/memory/assistantMemoryPool'
import type { AssistantMemoryRollup, AssistantMemorySlot } from '@shared/types'

function makeSlot(overrides: Partial<AssistantMemorySlot> = {}): AssistantMemorySlot {
  return {
    tabId: 'tab-1',
    tabTitle: 'Some tab',
    content: 'did some stuff',
    updatedAt: Date.now(),
    tokenEstimate: 100,
    lastMemorizedMessageId: 'msg-1',
    ...overrides
  }
}

describe('estimateTokens', () => {
  test('uses the char/4 heuristic, rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('ab')).toBe(1) // ceil(2/4) = 1
    expect(estimateTokens('a'.repeat(4))).toBe(1)
    expect(estimateTokens('a'.repeat(5))).toBe(2)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })
})

describe('sortSlotsByRecency', () => {
  test('orders newest first', () => {
    const older = makeSlot({ tabId: 'a', updatedAt: 1000 })
    const newer = makeSlot({ tabId: 'b', updatedAt: 2000 })
    const result = sortSlotsByRecency([older, newer])
    expect(result.map((s) => s.tabId)).toEqual(['b', 'a'])
  })

  test('tiebreaks deterministically on tabId when updatedAt is identical', () => {
    const b = makeSlot({ tabId: 'b', updatedAt: 5000 })
    const a = makeSlot({ tabId: 'a', updatedAt: 5000 })
    const result = sortSlotsByRecency([b, a])
    expect(result.map((s) => s.tabId)).toEqual(['a', 'b'])
  })

  test('does not mutate the input array', () => {
    const slots = [makeSlot({ tabId: 'a', updatedAt: 1 }), makeSlot({ tabId: 'b', updatedAt: 2 })]
    const original = [...slots]
    sortSlotsByRecency(slots)
    expect(slots).toEqual(original)
  })
})

describe('selectCompactionPlan', () => {
  test('reports no compaction needed when everything fits within the newest-40% cutoff', () => {
    const slots = [makeSlot({ tabId: 'a', updatedAt: 2000, tokenEstimate: 100 })]
    const plan = selectCompactionPlan(slots, null, 10_000) // cutoff = 4000
    expect(plan.needsCompaction).toBe(false)
    expect(plan.toKeep).toHaveLength(1)
    expect(plan.toCompact).toHaveLength(0)
  })

  test('flags older slots for compaction once the running total exceeds the 40% cutoff', () => {
    // budget 1000 -> cutoff 400. Two newest slots (300 each) fit one at a time; the third pushes over.
    const slots = [
      makeSlot({ tabId: 'newest', updatedAt: 3000, tokenEstimate: 300 }),
      makeSlot({ tabId: 'middle', updatedAt: 2000, tokenEstimate: 300 }),
      makeSlot({ tabId: 'oldest', updatedAt: 1000, tokenEstimate: 300 })
    ]
    const plan = selectCompactionPlan(slots, null, 1000)
    expect(plan.needsCompaction).toBe(true)
    expect(plan.toKeep.map((s) => s.tabId)).toEqual(['newest'])
    expect(plan.toCompact.map((s) => s.tabId)).toEqual(['middle', 'oldest'])
  })

  test('self-corrects on budget downsizing by flagging previously-kept slots next pass', () => {
    const slots = [
      makeSlot({ tabId: 'a', updatedAt: 3000, tokenEstimate: 1000 }),
      makeSlot({ tabId: 'b', updatedAt: 2000, tokenEstimate: 1000 })
    ]
    const bigBudgetPlan = selectCompactionPlan(slots, null, 20_000) // cutoff 8000, both fit
    expect(bigBudgetPlan.needsCompaction).toBe(false)

    const smallBudgetPlan = selectCompactionPlan(slots, null, 1000) // cutoff 400, neither fits fully but 'a' still gets tried first
    expect(smallBudgetPlan.needsCompaction).toBe(true)
    expect(smallBudgetPlan.toCompact.map((s) => s.tabId)).toContain('b')
  })

  test('an existing rollup does not by itself force compaction when no slot exceeds the cutoff', () => {
    const rollup: AssistantMemoryRollup = { content: 'old stuff', updatedAt: 1, tokenEstimate: 10 }
    const slots = [makeSlot({ tokenEstimate: 50 })]
    const plan = selectCompactionPlan(slots, rollup, 10_000)
    expect(plan.needsCompaction).toBe(false)
  })
})

describe('formatDigest', () => {
  test('returns empty string for an empty pool with no rollup', () => {
    expect(formatDigest([], null)).toBe('')
  })

  test('formats slots newest-first with relative time and content', () => {
    const slots = [
      makeSlot({ tabId: 'a', tabTitle: 'Email triage', updatedAt: Date.now() - 60_000, content: 'checked inbox' })
    ]
    const digest = formatDigest(slots, null)
    expect(digest).toContain('Email triage')
    expect(digest).toContain('checked inbox')
  })

  test('excludes the given tabId (a tab never sees its own slot)', () => {
    const slots = [makeSlot({ tabId: 'self', content: 'self note' }), makeSlot({ tabId: 'other', content: 'other note' })]
    const digest = formatDigest(slots, null, 'self')
    expect(digest).not.toContain('self note')
    expect(digest).toContain('other note')
  })

  test('includes the rollup content when present, appended after individual slots', () => {
    const rollup: AssistantMemoryRollup = { content: 'rolled up summary', updatedAt: Date.now(), tokenEstimate: 20 }
    const digest = formatDigest([makeSlot({ content: 'recent note' })], rollup)
    expect(digest).toContain('recent note')
    expect(digest).toContain('rolled up summary')
    expect(digest.indexOf('recent note')).toBeLessThan(digest.indexOf('rolled up summary'))
  })

  test('returns just the rollup when there are no visible slots', () => {
    const rollup: AssistantMemoryRollup = { content: 'only rollup', updatedAt: Date.now(), tokenEstimate: 5 }
    const digest = formatDigest([makeSlot({ tabId: 'self' })], rollup, 'self')
    expect(digest).toBe('Older Assistant-window history:\nonly rollup')
  })
})

describe('formatRelativeTime', () => {
  test('reports "just now" for very recent timestamps', () => {
    expect(formatRelativeTime(Date.now())).toBe('just now')
  })

  test('reports minutes for sub-hour deltas', () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe('5m')
  })

  test('reports hours for sub-day deltas', () => {
    expect(formatRelativeTime(Date.now() - 3 * 60 * 60_000)).toBe('3h')
  })

  test('reports days for multi-day deltas', () => {
    expect(formatRelativeTime(Date.now() - 2 * 24 * 60 * 60_000)).toBe('2d')
  })

  test('clamps a future timestamp to non-negative delta rather than going negative', () => {
    expect(formatRelativeTime(Date.now() + 60_000)).toBe('just now')
  })
})

describe('enforceRollupCeiling', () => {
  test('passes short content through unmodified', () => {
    const content = 'a short rollup note'
    expect(enforceRollupCeiling(content)).toBe(content)
  })

  test('truncates content over the token ceiling and appends a visible marker', () => {
    const content = 'a'.repeat((ROLLUP_TOKEN_CEILING + 500) * 4)
    const result = enforceRollupCeiling(content)
    expect(result.length).toBeLessThan(content.length)
    expect(result).toContain('[...truncated...]')
    expect(result.startsWith('a'.repeat(100))).toBe(true)
  })

  test('content exactly at the ceiling is left untouched', () => {
    const content = 'a'.repeat(ROLLUP_TOKEN_CEILING * 4)
    expect(enforceRollupCeiling(content)).toBe(content)
  })
})

describe('budgetTokensFor', () => {
  test('returns null for the disabled setting', () => {
    expect(budgetTokensFor('disabled')).toBeNull()
  })

  test('returns the numeric value for enabled sizes', () => {
    expect(budgetTokensFor(10000)).toBe(10000)
    expect(budgetTokensFor(20000)).toBe(20000)
  })
})
