import { describe, expect, test } from 'bun:test'
import {
  checkStepLimit,
  isSubagentBudgetExceeded,
  isTruncatedEmpty,
  isTruncatedToolCallJson,
  HARD_STEP_LIMIT,
  SUBAGENT_STEP_BUDGET
} from '../src/main/agent/turnControl'

describe('checkStepLimit', () => {
  test('auto mode never pauses below the hard ceiling', () => {
    expect(checkStepLimit({ stepCount: 0, continueMode: 'auto', checkpointSteps: 40 })).toBeNull()
    expect(checkStepLimit({ stepCount: 30, continueMode: 'auto', checkpointSteps: 40 })).toBeNull()
    expect(checkStepLimit({ stepCount: 200, continueMode: 'auto', checkpointSteps: 40 })).toBeNull()
  })

  test('auto mode still hits the hard safety ceiling eventually', () => {
    expect(checkStepLimit({ stepCount: HARD_STEP_LIMIT, continueMode: 'auto', checkpointSteps: 40 })).toBe('hard_limit')
  })

  test('checkpoint mode pauses once the configured step count is reached', () => {
    expect(checkStepLimit({ stepCount: 39, continueMode: 'checkpoint', checkpointSteps: 40 })).toBeNull()
    expect(checkStepLimit({ stepCount: 40, continueMode: 'checkpoint', checkpointSteps: 40 })).toBe('checkpoint')
  })

  test('checkpoint mode still respects the hard ceiling if checkpointSteps is configured huge', () => {
    expect(
      checkStepLimit({ stepCount: HARD_STEP_LIMIT, continueMode: 'checkpoint', checkpointSteps: 10_000 })
    ).toBe('hard_limit')
  })

  test('checkpointSteps is floored at 1 to avoid pausing before any work happens', () => {
    expect(checkStepLimit({ stepCount: 0, continueMode: 'checkpoint', checkpointSteps: 0 })).toBeNull()
    expect(checkStepLimit({ stepCount: 1, continueMode: 'checkpoint', checkpointSteps: 0 })).toBe('checkpoint')
  })
})

describe('isSubagentBudgetExceeded', () => {
  test('false below the fixed budget, true at/after it', () => {
    expect(isSubagentBudgetExceeded(0)).toBe(false)
    expect(isSubagentBudgetExceeded(SUBAGENT_STEP_BUDGET - 1)).toBe(false)
    expect(isSubagentBudgetExceeded(SUBAGENT_STEP_BUDGET)).toBe(true)
  })
})

describe('truncation detection', () => {
  test('isTruncatedEmpty only fires when finish_reason is length AND there is no output at all', () => {
    expect(isTruncatedEmpty('length', false, false)).toBe(true)
    expect(isTruncatedEmpty('length', true, false)).toBe(false)
    expect(isTruncatedEmpty('length', false, true)).toBe(false)
    expect(isTruncatedEmpty('stop', false, false)).toBe(false)
    expect(isTruncatedEmpty(undefined, false, false)).toBe(false)
  })

  test('isTruncatedToolCallJson only fires when finish_reason is length AND args failed to parse', () => {
    expect(isTruncatedToolCallJson('length', true)).toBe(true)
    expect(isTruncatedToolCallJson('length', false)).toBe(false)
    expect(isTruncatedToolCallJson('stop', true)).toBe(false)
    expect(isTruncatedToolCallJson(undefined, true)).toBe(false)
  })
})
