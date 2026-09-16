import { describe, expect, test } from 'bun:test'

import {
  isEmptyGeneration,
  shouldResumeAfterAuditCorrection,
  buildAuditResumeNudge,
  MAX_AUDIT_RESUMES
} from '../src/main/agent/turnControl'
import {
  detectFabrication,
  buildAuditNote,
  type DetectorInput
} from '../src/main/agent/verify/fabrication-detector'
import type { FabricationFinding } from '@shared/types'

/**
 * Regression tests for the "I was running the website skill and the job kept stopping" report
 * (global memory: "Klenny agent loop stalls after large parallel tool results"). Four stalls in one
 * session, three distinct causes, all of which ended a turn mid-task with no error:
 *
 *  Cause A — the generation came back empty (no text, no tool calls) and the harness accepted that
 *            as a finished task, because the retry was gated on finishReason === 'length'.
 *  Cause B — the fabrication guard's AUTOMATED VERIFICATION NOTICE told the model to answer it
 *            "and nothing else", so answering it correctly ended the turn with the task unfinished.
 *            Compounded by a C3 false positive that read a bare hostname as a claimed file.
 *  Cause C — compaction mid-task (already fixed; see compaction-resume.test.ts).
 */

const NOW = new Date(2026, 0, 15, 14, 16, 31).getTime()
const KNOWN_TOOLS = ['run_command', 'write_file', 'read_file', 'browser'] as const

function input(over: Partial<DetectorInput> = {}): DetectorInput {
  return {
    text: '',
    thisMessageToolCallCount: 0,
    turnLedger: [],
    sessionWritePaths: [],
    nowMs: NOW,
    root: '/repo',
    // Nothing exists on disk, so C3 fires whenever it is genuinely reached — that is what makes
    // the negative controls below meaningful rather than accidentally passing.
    fileExists: () => false,
    knownToolNames: KNOWN_TOOLS,
    contextKind: 'project-agent',
    ...over
  }
}

const codes = (f: FabricationFinding[]): string[] => f.map((x) => x.code)

// ---------------------------------------------------------------------------
// Cause A — an empty generation is not a finished task
// ---------------------------------------------------------------------------

describe('cause A: empty generation is never a clean end of turn', () => {
  test('a content-free generation is detected whatever the provider labelled it', () => {
    // The old gate (finishReason === 'length') is gone entirely: the label is not an input.
    expect(isEmptyGeneration(false, false)).toBe(true)
  })

  test('a generation that produced text or a tool call is left alone', () => {
    expect(isEmptyGeneration(false, true)).toBe(false)
    expect(isEmptyGeneration(true, false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cause B, part 1 — the notice must not forbid continuing
// ---------------------------------------------------------------------------

describe('cause B: the audit note no longer ends the task', () => {
  const note = (): string =>
    buildAuditNote(
      [{ code: 'C3', severity: 'hard', detail: 'claimed a file that does not exist' }],
      'LEDGER: NONE'
    )

  // The exact phrase that caused the stall. Read literally (and correctly), "do exactly one of the
  // following ... and nothing else" means the correction turn may not contain tool calls, so the
  // task halted on every notice — guaranteed for resolution (b), where there is nothing to redo.
  test('the "and nothing else" instruction is gone', () => {
    expect(note()).not.toContain('and nothing else')
  })

  test('it states plainly that the notice is not a stopping point', () => {
    expect(note()).toContain('not a stop signal')
    expect(note()).toContain('not the end of the task')
  })

  test('it asks for the next tool call in the same reply that resolves the claim', () => {
    expect(note()).toContain('next concrete tool call belongs in the same reply')
  })

  // The remedy for a fabricated claim is real work or a plain admission — the rewrite must not
  // have softened that into "keep going regardless", or it trades a stall for a fabrication.
  test('it still forbids inventing success and still allows admitting failure', () => {
    expect(note()).toContain('Reporting that something is not done is a fully acceptable outcome')
    expect(note()).toContain('do not describe any further action you have not actually taken')
  })
})

// ---------------------------------------------------------------------------
// Cause B, part 2 — the structural resume behind that wording
// ---------------------------------------------------------------------------

const base = {
  auditCorrections: 1,
  unfinishedChecklistItems: 2,
  auditResumes: 0,
  forcedCorrectionThisStep: false
}

describe('shouldResumeAfterAuditCorrection', () => {
  test('fires when a notice was answered earlier in the turn and work remains', () => {
    expect(shouldResumeAfterAuditCorrection(base)).toBe(true)
  })

  // Negative control: an ordinary text-only reply in a turn that never had a correction is a
  // perfectly normal end of turn (question answered, task done, clarification requested).
  test('does NOT fire when no correction happened in this turn', () => {
    expect(shouldResumeAfterAuditCorrection({ ...base, auditCorrections: 0 })).toBe(false)
  })

  // Same conservatism as the compaction resume: with no unfinished checklist there is no
  // harness-side evidence work remains, and forcing a step would pressure the model to invent some.
  test('does NOT fire when the checklist is fully checked or absent', () => {
    expect(shouldResumeAfterAuditCorrection({ ...base, unfinishedChecklistItems: 0 })).toBe(false)
  })

  test('does NOT fire when this step is itself forcing another correction (no double recursion)', () => {
    expect(shouldResumeAfterAuditCorrection({ ...base, forcedCorrectionThisStep: true })).toBe(false)
  })

  test('fires at most once per turn, so a model that really is done can still stop', () => {
    expect(shouldResumeAfterAuditCorrection({ ...base, auditResumes: MAX_AUDIT_RESUMES })).toBe(false)
    expect(shouldResumeAfterAuditCorrection({ ...base, auditResumes: MAX_AUDIT_RESUMES + 3 })).toBe(false)
  })

  test('the resume budget is exactly one', () => {
    expect(MAX_AUDIT_RESUMES).toBe(1)
  })
})

describe('buildAuditResumeNudge', () => {
  test('marks itself as harness-authored so it is never read as a user instruction', () => {
    expect(buildAuditResumeNudge({ unfinishedItems: 2 })).toContain('not by the user')
  })

  test('separates settling the claim from continuing the work, and asks for a tool call', () => {
    const nudge = buildAuditResumeNudge({ unfinishedItems: 3 })
    expect(nudge).toContain('3 unfinished items')
    expect(nudge).toContain('no tool calls')
    expect(nudge).toContain('does not end the task')
    expect(nudge).toContain('next concrete tool call')
  })

  test('names the next unfinished item when known, and pluralizes correctly', () => {
    const nudge = buildAuditResumeNudge({ unfinishedItems: 1, nextItem: 'Run the verification gate' })
    expect(nudge).toContain('1 unfinished item,')
    expect(nudge).toContain('"Run the verification gate"')
  })

  // This nudge lands immediately after the model was told its claims were unsupported. Pressuring
  // it to show progress there is precisely how a stall becomes a fabrication, so the escape hatch
  // and the ban on unverified completion are load-bearing, not boilerplate.
  test('keeps an escape hatch and forbids claiming unverified progress', () => {
    const nudge = buildAuditResumeNudge({ unfinishedItems: 2 })
    expect(nudge).toContain('genuinely complete')
    expect(nudge).toContain('genuinely blocked')
    expect(nudge).toContain('not actually verified')
    expect(nudge).toContain('never a request to claim progress')
  })
})

// ---------------------------------------------------------------------------
// Cause B, part 3 — the C3 false positive that triggered the notice
// ---------------------------------------------------------------------------

describe('C3 does not read a bare hostname as a claimed artifact', () => {
  // The actual observed false positive: a message about running the verification gate against the
  // live site was flagged for "creating dropbox.com", a file that of course does not exist. A
  // spurious hard finding cost a full correction turn and then stalled the task.
  test('a bare domain in a creation sentence is not a claimed file', () => {
    const r = detectFabrication(
      input({ text: 'I generated the comparison report and ran the gate against live dropbox.com.' })
    )
    expect(codes(r.hard)).not.toContain('C3')
  })

  test('the website-replica workflow domains are all safe', () => {
    for (const domain of ['cash.app', 'notion.so', 'coframe.com', 'vercel.app', 'openai.ai']) {
      const r = detectFabrication(input({ text: `I captured the hero section from ${domain}.` }))
      expect(codes(r.hard)).not.toContain('C3')
    }
  })

  // POSITIVE CONTROLS — a fix that simply blinded C3 would pass the assertions above, so these
  // must keep firing. Any future "simplification" of the hostname rule has to survive all of them.
  test('still flags a genuinely claimed artifact with a path separator', () => {
    const r = detectFabrication(
      input({ text: 'I created warehouse-allocator/manage.py with the standard scaffold.' })
    )
    expect(codes(r.hard)).toContain('C3')
  })

  test('still flags a domain-shaped token once it is path-qualified', () => {
    // `dropbox.com/index.html` is a real relative path shape, not a hostname.
    const r = detectFabrication(input({ text: 'I created dropbox.com/index.html from the capture.' }))
    expect(codes(r.hard)).toContain('C3')
  })

  test('still flags a shell script, whose extension is also a TLD', () => {
    // `.sh` is Sharjah's TLD but in practice always a script — deliberately excluded from TLD_RE.
    const r = detectFabrication(input({ text: 'I wrote build.sh to wrap the capture pipeline.' }))
    expect(codes(r.hard)).toContain('C3')
  })

  test('still flags ordinary source files with non-TLD extensions', () => {
    for (const file of ['globals.css', 'page.tsx', 'archive.7z', 'notes.md']) {
      const r = detectFabrication(input({ text: `I created ${file} for the replica.` }))
      expect(codes(r.hard)).toContain('C3')
    }
  })
})
