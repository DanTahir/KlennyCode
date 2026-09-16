import { describe, expect, test } from 'bun:test'
import {
  checkStepLimit,
  isSubagentBudgetExceeded,
  isEmptyGeneration,
  classifyToolCallJsonFailure,
  looksLikeTruncatedJson,
  describeToolArgsFailure,
  buildToolArgsRetryNudge,
  truncateSummary,
  HARD_STEP_LIMIT,
  SUBAGENT_STEP_BUDGET,
  MAX_SUBAGENT_SUMMARY_CHARS
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
  // Regression: the old isTruncatedEmpty required finishReason === 'length', so a content-free
  // generation labelled 'stop' — or with no finish_reason at all — was NOT recognized and fell
  // through to the no-tool-calls exit, silently ending the turn mid-task. That is the "job kept
  // stopping" stall. An empty generation is never a legitimate end of turn, whatever the label.
  test('isEmptyGeneration fires for a content-free generation regardless of finish_reason', () => {
    expect(isEmptyGeneration(false, false)).toBe(true)
  })

  test('isEmptyGeneration does not fire when the model actually produced something', () => {
    expect(isEmptyGeneration(true, false)).toBe(false)
    expect(isEmptyGeneration(false, true)).toBe(false)
    expect(isEmptyGeneration(true, true)).toBe(false)
  })

  test('classifyToolCallJsonFailure reports none when every call parsed', () => {
    expect(classifyToolCallJsonFailure('length', false)).toBe('none')
    expect(classifyToolCallJsonFailure('stop', false)).toBe('none')
    expect(classifyToolCallJsonFailure(undefined, false)).toBe('none')
  })

  test('unparsable args are a recoverable failure regardless of the reported finish_reason', () => {
    // The regression this replaced: the retry used to be gated on finishReason === 'length', so a
    // stream ending with 'stop', 'tool_calls', or no finish_reason at all fell straight through to
    // an opaque 'Invalid JSON args' tool error instead of retrying. That is the single biggest
    // cause of "multi_write just fails sometimes" — keep all four of these non-'none'.
    expect(classifyToolCallJsonFailure('length', true)).toBe('truncated')
    expect(classifyToolCallJsonFailure('stop', true)).toBe('invalid')
    expect(classifyToolCallJsonFailure('tool_calls', true)).toBe('invalid')
    expect(classifyToolCallJsonFailure(undefined, true)).toBe('invalid')
  })
})

describe('looksLikeTruncatedJson', () => {
  test('complete JSON is not flagged', () => {
    expect(looksLikeTruncatedJson('{"files":[{"path":"a.ts","content":"x"}]}')).toBe(false)
    expect(looksLikeTruncatedJson('{}')).toBe(false)
  })

  test('empty or whitespace-only args are not flagged as truncated', () => {
    expect(looksLikeTruncatedJson('')).toBe(false)
    expect(looksLikeTruncatedJson('   ')).toBe(false)
  })

  test('args cut off mid-string are flagged', () => {
    expect(looksLikeTruncatedJson('{"files":[{"path":"a.ts","content":"import Re')).toBe(true)
  })

  test('args cut off between entries (unclosed array/object) are flagged', () => {
    expect(looksLikeTruncatedJson('{"files":[{"path":"a.ts","content":"x"},')).toBe(true)
  })

  test('braces and escaped quotes inside a string value do not confuse the scan', () => {
    // File contents routinely contain both — a naive brace count would call this truncated.
    expect(looksLikeTruncatedJson('{"content":"function f() { return \\"}\\" }"}')).toBe(false)
  })
})

describe('describeToolArgsFailure', () => {
  test('names the tool, the size, that nothing ran, and what to do differently', () => {
    const raw = '{"files":[{"path":"a.ts","content":"import Re'
    const msg = describeToolArgsFailure('multi_write', raw)
    expect(msg).toContain('multi_write')
    expect(msg).toContain(`${raw.length} chars received`)
    expect(msg).toContain('Nothing was executed')
    expect(msg).toContain('output token limit')
    expect(msg).toContain('split it into several smaller calls')
  })

  test('an empty payload is described as such rather than as a truncation', () => {
    const msg = describeToolArgsFailure('multi_edit', '')
    expect(msg).toContain('no arguments were received at all')
    expect(msg).not.toContain('Last characters received')
  })

  test('structurally complete but invalid JSON is not blamed on the token limit', () => {
    const msg = describeToolArgsFailure('multi_write', '{"files": oops}')
    expect(msg).toContain('not valid JSON')
    expect(msg).not.toContain('output token limit')
  })
})

describe('buildToolArgsRetryNudge', () => {
  test('marks itself as harness-authored so it is never read as a user instruction', () => {
    expect(buildToolArgsRetryNudge('truncated', ['multi_write'])).toContain('not by the user')
  })

  test('names the affected tools (deduped) and asks for a smaller batch', () => {
    const nudge = buildToolArgsRetryNudge('truncated', ['multi_write', 'multi_write', 'multi_edit'])
    expect(nudge).toContain('multi_write, multi_edit')
    expect(nudge).toContain('split it into several calls')
    expect(nudge).toContain('Nothing ran')
  })

  test('the empty-generation variant asks for concision instead of a smaller batch', () => {
    const nudge = buildToolArgsRetryNudge('empty')
    expect(nudge).toContain('no text and no tool calls at all')
    expect(nudge).not.toContain('multi_write')
  })

  // It fires for any content-free generation, including ones the provider labelled 'stop', so it
  // must not assert the output-token-limit as the cause the way the 'truncated' variant does.
  test('the empty-generation variant does not claim a cause the provider never reported', () => {
    expect(buildToolArgsRetryNudge('empty')).toContain('the provider did not report which')
  })

  test('the invalid variant does not claim the provider reported hitting the limit', () => {
    expect(buildToolArgsRetryNudge('invalid', ['multi_edit'])).toContain('did not report hitting the limit')
  })
})

describe('truncateSummary', () => {
  test('passes short text through unmodified, with no marker appended', () => {
    const text = 'a subagent summary well under the limit'
    expect(truncateSummary(text)).toBe(text)
  })

  test('passes text exactly at the limit through unmodified', () => {
    const text = 'x'.repeat(MAX_SUBAGENT_SUMMARY_CHARS)
    expect(truncateSummary(text)).toBe(text)
  })

  test('truncates text over the limit and appends a visible marker stating how much was omitted', () => {
    const text = 'x'.repeat(MAX_SUBAGENT_SUMMARY_CHARS + 500)
    const result = truncateSummary(text)
    expect(result.length).toBeGreaterThan(MAX_SUBAGENT_SUMMARY_CHARS)
    expect(result.startsWith('x'.repeat(MAX_SUBAGENT_SUMMARY_CHARS))).toBe(true)
    expect(result).toContain('[...500 characters truncated...]')
  })

  test('respects a custom maxChars override', () => {
    const text = 'abcdefghij'
    expect(truncateSummary(text, 5)).toBe('abcde\n\n[...5 characters truncated...]')
    expect(truncateSummary(text, 100)).toBe(text)
  })
})
