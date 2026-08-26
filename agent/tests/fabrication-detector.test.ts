import { describe, expect, test } from 'bun:test'

import {
  detectFabrication,
  scopeForContext,
  stripCodeSpans,
  buildAuditNote,
  type DetectorInput
} from '../src/main/agent/verify/fabrication-detector'
import type { LedgerEntry, PathTouch } from '../src/main/agent/orchestrator/ledger'
import type { ChecklistItem } from '@shared/types'

// The injected clock from the real incident: 14:16:31 on the day of the fabricated build.
const NOW = new Date(2026, 0, 15, 14, 16, 31).getTime()

const KNOWN_TOOLS = [
  'run_command',
  'read_file',
  'write_file',
  'edit_file',
  'multi_edit',
  'grep',
  'glob',
  'update_checklist',
  'create_checklist',
  'write_memory',
  'browser',
  'task'
] as const

function entry(n: number, toolName: string, argsDigest = '{}'): LedgerEntry {
  return { n, toolName, argsDigest, status: 'success', at: NOW - 60_000 }
}

/** Nothing exists on disk unless a test says otherwise — the incident's situation exactly. */
function input(over: Partial<DetectorInput> = {}): DetectorInput {
  return {
    text: '',
    thisMessageToolCallCount: 0,
    turnLedger: [],
    sessionWritePaths: [],
    nowMs: NOW,
    root: '/repo',
    fileExists: () => false,
    knownToolNames: KNOWN_TOOLS,
    contextKind: 'project-agent',
    ...over
  }
}

function codes(findings: { code: string }[]): string[] {
  return findings.map((f) => f.code)
}

function checklist(doneCount: number, total: number): { title: string; items: ChecklistItem[] } {
  const items: ChecklistItem[] = Array.from({ length: total }, (_, i) => ({
    id: `item-${i + 1}`,
    text: `Step ${i + 1}`,
    done: i < doneCount
  }))
  return { title: 'Warehouse Allocator build', items }
}

// ---------------------------------------------------------------------------
// Incident replay — the four hard checks against the actual fabricated turn
// ---------------------------------------------------------------------------

describe('incident replay (must be caught)', () => {
  test('C1 flags a completion time in the future relative to the injected clock', () => {
    const r = detectFabrication(
      input({ text: 'Full build finished at 14:22:05 with everything green.' })
    )
    expect(codes(r.hard)).toContain('C1')
    expect(r.hard[0].detail).toContain('future')
  })

  test('C1 flags a future am/pm completion time', () => {
    const r = detectFabrication(input({ text: 'Wrapped up at 3:45:00 pm, all green.' }))
    expect(codes(r.hard)).toContain('C1')
  })

  test('C2a flags hand-written tool-call marker syntax', () => {
    const r = detectFabrication(
      input({ text: 'I updated the tracker [called update_checklist({"updates":[]})] and moved on.' })
    )
    expect(codes(r.hard)).toContain('C2a')
  })

  test('C2a also inspects thinking blocks', () => {
    const r = detectFabrication(
      input({ text: 'Done.', thinking: 'Next [called run_command(pytest)] so tests are green.' })
    )
    expect(codes(r.hard)).toContain('C2a')
  })

  test('C3 flags a claimed artifact that was never written and does not exist', () => {
    const r = detectFabrication(
      input({ text: 'I created warehouse-allocator/manage.py with the standard scaffold.' })
    )
    expect(codes(r.hard)).toContain('C3')
    expect(r.hard[0].detail).toContain('manage.py')
  })

  test('C4 flags wholesale completion against a 0/9 checklist with no update_checklist call', () => {
    const r = detectFabrication(
      input({ text: 'All 9 items are now done.', activeChecklist: checklist(0, 9) })
    )
    expect(codes(r.hard)).toContain('C4')
    expect(r.hard[0].detail).toContain('9 unfinished')
  })

  test('C4 catches the "9 of 9 complete" phrasing too', () => {
    const r = detectFabrication(
      input({ text: 'That is 9 of 9 items complete.', activeChecklist: checklist(0, 9) })
    )
    expect(codes(r.hard)).toContain('C4')
  })

  test('C5 flags a heavy result-narrating message with zero tool calls', () => {
    const text = [
      'Ran the suite and the migrations.',
      '$ python manage.py test',
      'The runner reported 22 passed with exit code 0.',
      'The endpoint answered HTTP/1.1 and returned 201 Created.',
      'Total wall time was 11.9s for the sweep.',
      'The migration step reported 6 rows migrated.'
    ].join('\n')
    const r = detectFabrication(input({ text }))
    expect(codes(r.soft)).toContain('C5')
  })
})

// ---------------------------------------------------------------------------
// False-positive suite — equally important; a noisy guard gets switched off
// ---------------------------------------------------------------------------

describe('false positives (must NOT be flagged)', () => {
  test('future-tense intent is not an artifact claim', () => {
    const r = detectFabrication(input({ text: 'Next I will create src/newthing.ts and wire it up.' }))
    expect(r.hard).toHaveLength(0)
  })

  test('an honest rejected write is not flagged', () => {
    const r = detectFabrication(
      input({ text: 'I tried to write src/nope.ts but the approval was rejected, so nothing changed.' })
    )
    expect(r.hard).toHaveLength(0)
  })

  test('a real write attempt suppresses C3 even when the write failed', () => {
    const writes: PathTouch[] = [
      { path: 'warehouse-allocator/manage.py', toolName: 'write_file', status: 'error' }
    ]
    const r = detectFabrication(
      input({
        text: 'I created warehouse-allocator/manage.py with the standard scaffold.',
        sessionWritePaths: writes
      })
    )
    expect(codes(r.hard)).not.toContain('C3')
  })

  test('a file that actually exists on disk is not flagged', () => {
    const r = detectFabrication(
      input({ text: 'I created src/real.ts for this.', fileExists: () => true })
    )
    expect(codes(r.hard)).not.toContain('C3')
  })

  test('cron expressions are not wall-clock times', () => {
    const r = detectFabrication(
      input({ text: 'The scheduled job is done; its cron is 0 9 * * * in local time.' })
    )
    expect(codes(r.hard)).not.toContain('C1')
  })

  test('sub-second durations are not wall-clock times', () => {
    const r = detectFabrication(input({ text: 'The suite finished in 1.29s, all green.' }))
    expect(codes(r.hard)).not.toContain('C1')
  })

  test('bare MM:SS elapsed figures are not wall-clock times', () => {
    const r = detectFabrication(input({ text: 'Build complete, 22:03 total elapsed.' }))
    expect(codes(r.hard)).not.toContain('C1')
  })

  test('an HH:MM:SS duration framed as a span is not a completion instant', () => {
    const r = detectFabrication(input({ text: 'The whole thing completed in 1:02:03 of runtime.' }))
    expect(codes(r.hard)).not.toContain('C1')
  })

  test('a completion time in the past is fine', () => {
    const r = detectFabrication(input({ text: 'Finished at 14:10:00, well before the deadline.' }))
    expect(codes(r.hard)).not.toContain('C1')
  })

  test('semver-looking numbers are not times', () => {
    const r = detectFabrication(input({ text: 'Upgrade complete: django 5.1.2 is installed.' }))
    expect(codes(r.hard)).not.toContain('C1')
  })

  test('fenced code blocks quoting real prior output do not count as claims', () => {
    const text = [
      'Here is the output from the earlier run:',
      '```',
      '$ pytest -q',
      '22 passed in 11.9s',
      'exit code 0',
      'HTTP/1.1 201 Created',
      '3 files created',
      'real 0m11.9s',
      'OK (22 tests)',
      '```',
      'That is what I was referring to.'
    ].join('\n')
    const r = detectFabrication(input({ text }))
    expect(codes(r.soft)).not.toContain('C5')
    expect(r.hard).toHaveLength(0)
  })

  test('backticked tool names and "the X tool" phrasing are not call claims', () => {
    const r = detectFabrication(
      input({ text: 'The `read_file` tool returns numbered lines, and grep is better for exact matches.' })
    )
    expect(r.soft).toHaveLength(0)
    expect(r.hard).toHaveLength(0)
  })

  test('discussing a tool without first-person completion is not a C2b claim', () => {
    const r = detectFabrication(
      input({ text: 'The write_file tool would overwrite it, so multi_edit is the better choice here.' })
    )
    expect(codes(r.soft)).not.toContain('C2b')
  })

  test('system paths are skipped', () => {
    const r = detectFabrication(input({ text: 'The config I wrote reads /etc/hosts at boot.' }))
    expect(codes(r.hard)).not.toContain('C3')
  })

  test('URLs are not artifact paths', () => {
    const r = detectFabrication(
      input({ text: 'I wrote the docs and published them to https://example.com/guide.html today.' })
    )
    expect(codes(r.hard)).not.toContain('C3')
  })

  test('a truthful message that really did call tools is clean', () => {
    const r = detectFabrication(
      input({
        text: 'I created src/real.ts and ran the tests; everything passes.',
        thisMessageToolCallCount: 2,
        turnLedger: [entry(1, 'write_file', '{"path":"src/real.ts"}'), entry(2, 'run_command')],
        sessionWritePaths: [{ path: 'src/real.ts', toolName: 'write_file', status: 'success' }]
      })
    )
    expect(r.hard).toHaveLength(0)
    expect(r.soft).toHaveLength(0)
  })

  test('C2b does not fire when the tool really was called this turn', () => {
    const r = detectFabrication(
      input({
        text: 'I called update_checklist to mark step 3 done.',
        turnLedger: [entry(1, 'update_checklist')]
      })
    )
    expect(codes(r.soft)).not.toContain('C2b')
  })

  test('C4 stays quiet when the checklist genuinely is complete', () => {
    const r = detectFabrication(
      input({ text: 'All 9 items are now done.', activeChecklist: checklist(9, 9) })
    )
    expect(codes(r.hard)).not.toContain('C4')
  })

  test('C4 stays quiet when there is no active checklist', () => {
    const r = detectFabrication(input({ text: 'All 9 items are now done.' }))
    expect(codes(r.hard)).not.toContain('C4')
  })

  test('C4 defers when update_checklist actually ran this turn', () => {
    const r = detectFabrication(
      input({
        text: 'All 9 items are now done.',
        activeChecklist: checklist(0, 9),
        turnLedger: [entry(1, 'update_checklist')]
      })
    )
    expect(codes(r.hard)).not.toContain('C4')
  })

  test('a short ordinary answer with no tool calls is clean', () => {
    const r = detectFabrication(
      input({ text: 'Yes — the orchestrator splits the loop from the tool dispatch. Want me to walk through it?' })
    )
    expect(r.hard).toHaveLength(0)
    expect(r.soft).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Soft checks and scoping
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// C4 Case B — the plan-gate escalation: checklist reads complete, but only because items were
// marked done in a turn that did no real work.
// ---------------------------------------------------------------------------

describe('C4 case B (plan-gate escalation)', () => {
  /** A fully-done checklist where every item carries the unverified tag. */
  function unbackedComplete(total: number): { title: string; items: ChecklistItem[] } {
    return {
      title: 'Warehouse Allocator build',
      items: Array.from({ length: total }, (_, i) => ({
        id: `item-${i + 1}`,
        text: `Step ${i + 1}`,
        done: true,
        evidenceQuality: 'unverified-no-tool-calls' as const
      }))
    }
  }

  test('escalates when a wholesale completion rests on unbacked items marked this turn', () => {
    const r = detectFabrication(
      input({
        text: 'All 9 items are now done.',
        activeChecklist: unbackedComplete(9),
        turnLedger: [entry(1, 'update_checklist')]
      })
    )
    expect(codes(r.hard)).toContain('C4')
    expect(r.hard[0].detail).toContain('not evidence')
  })

  test('does not escalate when the same turn also did real work', () => {
    const r = detectFabrication(
      input({
        text: 'All 9 items are now done.',
        activeChecklist: unbackedComplete(9),
        turnLedger: [entry(1, 'write_file'), entry(2, 'update_checklist')]
      })
    )
    expect(codes(r.hard)).not.toContain('C4')
  })

  test('does not escalate on a later honest recap turn (no update_checklist call)', () => {
    // The tags are stale from an earlier turn; this turn merely reports the state.
    const r = detectFabrication(
      input({ text: 'All 9 items are now done.', activeChecklist: unbackedComplete(9) })
    )
    expect(codes(r.hard)).not.toContain('C4')
  })

  test('does not escalate when items are properly backed', () => {
    const r = detectFabrication(
      input({
        text: 'All 9 items are now done.',
        activeChecklist: checklist(9, 9),
        turnLedger: [entry(1, 'update_checklist')]
      })
    )
    expect(codes(r.hard)).not.toContain('C4')
  })
})

describe('C2b prose tool claim (soft)', () => {
  test('flags a first-person claim for a tool absent from the ledger', () => {
    const r = detectFabrication(input({ text: 'I called update_checklist after each step.' }))
    expect(codes(r.soft)).toContain('C2b')
    expect(r.hard).toHaveLength(0) // soft only, never hard — regex cannot prove intent
  })

  test('unknown tool names are ignored', () => {
    const r = detectFabrication(input({ text: 'I ran make_widgets to regenerate them.' }))
    expect(codes(r.soft)).not.toContain('C2b')
  })

  test('reports each fabricated tool only once', () => {
    const r = detectFabrication(
      input({ text: 'I called write_memory here. Later I called write_memory again.' })
    )
    expect(r.soft.filter((f) => f.code === 'C2b')).toHaveLength(1)
  })
})

describe('C6 turn-size cap (soft)', () => {
  test('flags a very long message with no tool calls and lowers the C5 bar', () => {
    const filler = 'The service layer now handles retries and backoff correctly. '.repeat(160)
    const r = detectFabrication(
      input({ text: `${filler}\nThe runner reported 22 passed with exit code 0 in 11.9s.` })
    )
    expect(codes(r.soft)).toContain('C6')
    expect(codes(r.soft)).toContain('C5') // 3 signals is enough once bulk is detected
  })

  test('does not fire when the message actually made tool calls', () => {
    const filler = 'The service layer now handles retries and backoff correctly. '.repeat(160)
    const r = detectFabrication(input({ text: filler, thisMessageToolCallCount: 1 }))
    expect(r.soft).toHaveLength(0)
  })
})

describe('scoping matrix', () => {
  test('plan mode disables C3/C5/C6 but keeps the clock and marker checks', () => {
    const scope = scopeForContext('plan')
    expect(scope.has('C1')).toBe(true)
    expect(scope.has('C2a')).toBe(true)
    expect(scope.has('C4')).toBe(true)
    expect(scope.has('C3')).toBe(false)
    expect(scope.has('C5')).toBe(false)
    expect(scope.has('C6')).toBe(false)
  })

  test('every other context runs the full suite', () => {
    for (const kind of ['project-agent', 'assistant', 'subagent', 'scheduled'] as const) {
      expect(scopeForContext(kind).size).toBe(7)
    }
  })

  test('plan-mode prose describing files it intends to create is not flagged', () => {
    const r = detectFabrication(
      input({
        contextKind: 'plan',
        text: 'Phase 1 adds src/main/agent/verify/fabrication-detector.ts and wires it into loop.ts.'
      })
    )
    expect(r.hard).toHaveLength(0)
  })

  test('C3 is skipped entirely when no root is available', () => {
    const r = detectFabrication(
      input({ root: undefined, text: 'I created warehouse-allocator/manage.py just now.' })
    )
    expect(codes(r.hard)).not.toContain('C3')
  })
})

describe('helpers', () => {
  test('stripCodeSpans removes fences and inline spans, preserving sentence breaks', () => {
    const out = stripCodeSpans('before ```\nrm -rf /\n``` middle `inline` after.')
    expect(out).not.toContain('rm -rf')
    expect(out).not.toContain('inline')
    expect(out).toContain('before')
    expect(out).toContain('after')
  })

  test('stripCodeSpans handles an unterminated fence', () => {
    expect(stripCodeSpans('text ```\nunclosed output')).not.toContain('unclosed')
  })

  test('buildAuditNote includes findings, the ledger digest, and both response options', () => {
    const note = buildAuditNote(
      [{ code: 'C3', severity: 'hard', detail: 'no such file', excerpt: 'I created x.ts' }],
      'LEDGER: NONE'
    )
    expect(note).toContain('[C3]')
    expect(note).toContain('no such file')
    expect(note).toContain('I created x.ts')
    expect(note).toContain('LEDGER: NONE')
    expect(note).toContain('(a)')
    expect(note).toContain('(b)')
  })
})
