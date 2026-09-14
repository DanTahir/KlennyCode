import { describe, expect, test } from 'bun:test'
import {
  shouldResumeAfterCompaction,
  buildCompactionResumeNudge,
  MAX_COMPACTION_RESUMES
} from '../src/main/agent/turnControl'
import { toORMessages } from '../src/main/agent/messages'

/**
 * Regression tests for the "agent silently freezes mid-task on the turn compaction fires" bug.
 *
 * Mechanism (see project memory "Post-compaction silent stop"): compaction injects a summary
 * system message mid-turn; the model treats it as a natural wrap-up point and replies with text
 * and no tool calls; the orchestrator's `!toolCalls.length` exit cannot tell that apart from a
 * finished task and returns 'natural'. No retry, no event, no error — the spinner just stops.
 * The only prior defense was a one-shot prompt cue, which failed three times in one session.
 */

const base = {
  compactedThisStep: true,
  unfinishedChecklistItems: 2,
  compactionResumes: 0,
  auditForcedCorrection: false
}

describe('shouldResumeAfterCompaction', () => {
  test('fires when compaction ran this step and the checklist still has unfinished items', () => {
    expect(shouldResumeAfterCompaction(base)).toBe(true)
  })

  test('fires for a single remaining item (the phase-9 shape of the observed freeze)', () => {
    expect(shouldResumeAfterCompaction({ ...base, unfinishedChecklistItems: 1 })).toBe(true)
  })

  // Negative control: an ordinary text-only reply on a step where nothing was compacted is a
  // perfectly normal end of turn (the model answered a question, finished the task, etc.).
  test('does NOT fire when compaction did not run on this step', () => {
    expect(shouldResumeAfterCompaction({ ...base, compactedThisStep: false })).toBe(false)
  })

  // Negative control from the memory's proposed test: with no unfinished work there is no
  // harness-side evidence the task isn't done, and forcing another step would only pressure the
  // model into inventing work / claiming progress.
  test('does NOT fire when the checklist is fully checked or absent', () => {
    expect(shouldResumeAfterCompaction({ ...base, unfinishedChecklistItems: 0 })).toBe(false)
  })

  test('does NOT fire when the fabrication guard already forced a correction turn', () => {
    expect(shouldResumeAfterCompaction({ ...base, auditForcedCorrection: true })).toBe(false)
  })

  test('fires at most once per turn, so a model that really is done can still stop', () => {
    expect(shouldResumeAfterCompaction({ ...base, compactionResumes: MAX_COMPACTION_RESUMES })).toBe(false)
    expect(shouldResumeAfterCompaction({ ...base, compactionResumes: MAX_COMPACTION_RESUMES + 5 })).toBe(false)
  })

  test('the resume budget is exactly one', () => {
    expect(MAX_COMPACTION_RESUMES).toBe(1)
  })
})

describe('buildCompactionResumeNudge', () => {
  test('marks itself as harness-authored so it is never read as a user instruction', () => {
    expect(buildCompactionResumeNudge({ unfinishedItems: 2 })).toContain('not by the user')
  })

  test('states why the turn was resumed and asks for the next tool call in this reply', () => {
    const nudge = buildCompactionResumeNudge({ unfinishedItems: 3 })
    expect(nudge).toContain('3 unfinished items')
    expect(nudge).toContain('no tool calls')
    expect(nudge).toContain('not a stopping point')
    expect(nudge).toContain('next concrete tool call')
  })

  test('names the next unfinished item when one is known, and pluralizes correctly', () => {
    const nudge = buildCompactionResumeNudge({ unfinishedItems: 1, nextItem: 'Wire up the image tool' })
    expect(nudge).toContain('1 unfinished item,')
    expect(nudge).toContain('"Wire up the image tool"')
  })

  // The nudge fires exactly when the model believes it is finished, so it must not become a
  // pressure-to-fabricate: it has to keep an explicit escape hatch and an explicit ban on
  // claiming unverified progress. Trading a silent stop for a fabricated completion is no win.
  test('keeps an escape hatch and forbids claiming unverified progress', () => {
    const nudge = buildCompactionResumeNudge({ unfinishedItems: 2 })
    expect(nudge).toContain('genuinely complete')
    expect(nudge).toContain('genuinely blocked')
    expect(nudge).toContain('not actually verified')
    expect(nudge).toContain('never a request to claim progress')
  })
})

describe('justCompacted cue no longer invites a standalone acknowledgment', () => {
  const summaryOf = (justCompacted: boolean): string => {
    const wire = toORMessages([], 'SYS', 'SUMMARY BODY', justCompacted)
    return wire.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n')
  }

  // The old cue asked the model to "briefly mention in one short sentence" that it compacted,
  // which primed precisely the text-block-with-no-tool-call reply that triggers the stop — the
  // mitigation partially induced the failure it existed to prevent.
  test('the cue asks for the tool call in the same reply instead of a lone sentence', () => {
    const cue = summaryOf(true)
    expect(cue).toContain('the next concrete tool call belongs in that same reply')
    expect(cue).toContain('do not send a standalone acknowledgment')
    expect(cue).not.toContain('briefly mention in one short sentence')
  })

  test('the cue mentions that the harness will auto-resume a tool-call-less stop', () => {
    expect(summaryOf(true)).toContain('resume you automatically')
  })

  test('none of that appears on later turns that merely carry the summary forward', () => {
    const cue = summaryOf(false)
    expect(cue).toContain('SUMMARY BODY')
    expect(cue).not.toContain('resume you automatically')
    expect(cue).not.toContain('standalone acknowledgment')
  })
})
