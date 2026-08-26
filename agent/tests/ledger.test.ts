import { describe, expect, test } from 'bun:test'

import {
  buildTurnLedger,
  buildSessionWritePaths,
  buildLedgerDigest,
  turnHasSubstantiveToolCall,
  toolNamesIn
} from '../src/main/agent/orchestrator/ledger'
import type { ChatMessage, ToolCallBlock } from '@shared/types'

function userMsg(id: string, text: string, isAuditNote?: boolean): ChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }],
    createdAt: 1000,
    ...(isAuditNote ? { isAuditNote: true } : {})
  }
}

function toolCall(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  status: ToolCallBlock['status'] = 'success'
): ToolCallBlock {
  return { type: 'tool_call', id, toolName, args, status }
}

/** An assistant message the way loop.ts records it: free text plus the tool_call blocks it
 *  requested, each carrying real parsed args. */
function assistantWithCalls(id: string, text: string, calls: ToolCallBlock[]): ChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text } as const, ...calls],
    createdAt: 2000
  }
}

/** The mirrored `role: 'tool'` message loop.ts also pushes for every executed call. Its block
 *  deliberately has EMPTY args — this is exactly why the ledger must read from assistant
 *  messages only, or every call would be counted twice (once with args, once without). */
function toolResultMsg(id: string, toolName: string): ChatMessage {
  return {
    id,
    role: 'tool',
    blocks: [toolCall(`${id}-tc`, toolName, {}, 'success')],
    createdAt: 2001
  }
}

describe('buildTurnLedger', () => {
  test('collects tool calls since the last real user message, in order, without double-counting the mirrored tool-role message', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'older turn'),
      assistantWithCalls('a1', 'old work', [toolCall('tc-old', 'grep', { pattern: 'x' })]),
      toolResultMsg('t-old', 'grep'),
      userMsg('u2', 'current turn'),
      assistantWithCalls('a2', 'working', [
        toolCall('tc1', 'run_command', { command: 'date' }),
        toolCall('tc2', 'read_file', { path: 'a.ts' })
      ]),
      toolResultMsg('t1', 'run_command'),
      toolResultMsg('t2', 'read_file')
    ]

    const ledger = buildTurnLedger(messages)
    // Two calls this turn — NOT four (the mirrored tool-role messages must not be counted), and
    // NOT three (the previous turn's grep is before the boundary).
    expect(ledger.length).toBe(2)
    expect(ledger.map((e) => e.toolName)).toEqual(['run_command', 'read_file'])
    expect(ledger.map((e) => e.n)).toEqual([1, 2])
    // args survived, which is only true when read off the assistant message
    expect(ledger[0].argsDigest).toContain('date')
    expect(ledger[1].argsDigest).toContain('a.ts')
  })

  test('an injected audit note is NOT treated as a turn boundary', () => {
    // This is the regression the plan-checker flagged: audit notes must be role:'user' on the
    // wire, but if the boundary walk stopped at one, the correction turn would see an EMPTY
    // ledger — erasing precisely the evidence that the preceding claims were unsupported.
    const messages: ChatMessage[] = [
      userMsg('u1', 'real user request'),
      assistantWithCalls('a1', 'I did lots of things', [toolCall('tc1', 'run_command', { command: 'ls' })]),
      toolResultMsg('t1', 'run_command'),
      userMsg('audit1', 'AUDIT NOTE: unsupported claims detected', true)
    ]

    const ledger = buildTurnLedger(messages)
    expect(ledger.length).toBe(1)
    expect(ledger[0].toolName).toBe('run_command')
  })

  test('returns an empty ledger for a turn that has made no tool calls at all', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'build me a thing'),
      { id: 'a1', role: 'assistant', blocks: [{ type: 'text', text: 'Sure!' }], createdAt: 2000 }
    ]
    expect(buildTurnLedger(messages)).toEqual([])
  })

  test('handles a history with no user message at all (e.g. a subagent kickoff)', () => {
    const messages: ChatMessage[] = [
      assistantWithCalls('a1', 'go', [toolCall('tc1', 'glob', { pattern: '**/*.ts' })])
    ]
    expect(buildTurnLedger(messages).length).toBe(1)
  })

  test('records non-success statuses rather than dropping them', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'do it'),
      assistantWithCalls('a1', 'trying', [
        toolCall('tc1', 'write_file', { path: 'x.ts' }, 'rejected'),
        toolCall('tc2', 'run_command', { command: 'boom' }, 'error')
      ])
    ]
    const ledger = buildTurnLedger(messages)
    expect(ledger.map((e) => e.status)).toEqual(['rejected', 'error'])
  })
})

describe('turnHasSubstantiveToolCall', () => {
  test('checklist bookkeeping alone does not count as substantive work', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'go'),
      assistantWithCalls('a1', 'marking done', [
        toolCall('tc1', 'update_checklist', { updates: [] }),
        toolCall('tc2', 'create_checklist', { title: 't' })
      ])
    ]
    const ledger = buildTurnLedger(messages)
    expect(ledger.length).toBe(2)
    // The claim being audited cannot serve as its own evidence.
    expect(turnHasSubstantiveToolCall(ledger)).toBe(false)
  })

  test('any real tool call counts', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'go'),
      assistantWithCalls('a1', 'reading', [
        toolCall('tc1', 'update_checklist', { updates: [] }),
        toolCall('tc2', 'read_file', { path: 'a.ts' })
      ])
    ]
    expect(turnHasSubstantiveToolCall(buildTurnLedger(messages))).toBe(true)
  })
})

describe('toolNamesIn', () => {
  test('dedupes tool names', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'go'),
      assistantWithCalls('a1', 'x', [
        toolCall('tc1', 'read_file', { path: 'a' }),
        toolCall('tc2', 'read_file', { path: 'b' })
      ])
    ]
    const names = toolNamesIn(buildTurnLedger(messages))
    expect([...names]).toEqual(['read_file'])
  })
})

describe('buildSessionWritePaths', () => {
  test('collects write-tool paths across the WHOLE session, not just the current turn', () => {
    // A file written many turns ago is still a real artifact the model may correctly mention now.
    const messages: ChatMessage[] = [
      userMsg('u1', 'first'),
      assistantWithCalls('a1', 'writing', [toolCall('tc1', 'write_file', { path: 'src/old.ts' })]),
      userMsg('u2', 'second'),
      assistantWithCalls('a2', 'reading only', [toolCall('tc2', 'read_file', { path: 'src/other.ts' })])
    ]
    const paths = buildSessionWritePaths(messages).map((p) => p.path)
    expect(paths).toContain('src/old.ts')
    // read_file is not a write tool — it must not make a path count as "created"
    expect(paths).not.toContain('src/other.ts')
  })

  test('extracts every per-edit path from multi_edit, plus the top-level default', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'go'),
      assistantWithCalls('a1', 'batch', [
        toolCall('tc1', 'multi_edit', {
          path: 'default.ts',
          edits: [{ path: 'a.ts', old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }, { path: 'b.ts' }]
        })
      ])
    ]
    const paths = buildSessionWritePaths(messages).map((p) => p.path)
    expect(paths).toContain('default.ts')
    expect(paths).toContain('a.ts')
    expect(paths).toContain('b.ts')
  })

  test('retains rejected/failed write attempts', () => {
    // Critical for false-positive avoidance: "I tried to write X but it was rejected" is honest
    // narration, so the artifact check must still see an attempt against that path.
    const messages: ChatMessage[] = [
      userMsg('u1', 'go'),
      assistantWithCalls('a1', 'attempting', [toolCall('tc1', 'write_file', { path: 'blocked.ts' }, 'rejected')])
    ]
    const touches = buildSessionWritePaths(messages)
    expect(touches.length).toBe(1)
    expect(touches[0].path).toBe('blocked.ts')
    expect(touches[0].status).toBe('rejected')
  })

  test('ignores delete_file (deleting a file is not a claim that it exists)', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'go'),
      assistantWithCalls('a1', 'removing', [toolCall('tc1', 'delete_file', { path: 'gone.ts' })])
    ]
    expect(buildSessionWritePaths(messages).map((p) => p.path)).not.toContain('gone.ts')
  })
})

describe('buildLedgerDigest', () => {
  test('empty ledger states plainly that nothing has run', () => {
    const digest = buildLedgerDigest([])
    expect(digest).toContain('NONE')
    expect(digest).toContain('No tool has been called yet this turn')
  })

  test('lists calls with numbering and status, and frames itself as harness-generated', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'go'),
      assistantWithCalls('a1', 'x', [
        toolCall('tc1', 'run_command', { command: 'date' }),
        toolCall('tc2', 'write_file', { path: 'a.ts' }, 'error')
      ])
    ]
    const digest = buildLedgerDigest(buildTurnLedger(messages))
    expect(digest).toContain('1. run_command')
    expect(digest).toContain('2. write_file')
    expect(digest).toContain('→ error')
    expect(digest).toContain('machine-maintained by the harness')
    expect(digest).toContain('2 total')
  })

  test('caps the listed entries but still reports the true total', () => {
    const calls = Array.from({ length: 40 }, (_, i) => toolCall(`tc${i}`, 'read_file', { path: `f${i}.ts` }))
    const messages: ChatMessage[] = [userMsg('u1', 'go'), assistantWithCalls('a1', 'x', calls)]
    const digest = buildLedgerDigest(buildTurnLedger(messages))
    expect(digest).toContain('40 total')
    expect(digest).toContain('showing the most recent 25')
    // oldest entries elided, newest retained
    expect(digest).not.toContain('f0.ts')
    expect(digest).toContain('f39.ts')
  })

  test('truncates very long argument payloads', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'go'),
      assistantWithCalls('a1', 'x', [toolCall('tc1', 'write_file', { path: 'a.ts', content: 'z'.repeat(5000) })])
    ]
    const digest = buildLedgerDigest(buildTurnLedger(messages))
    expect(digest).toContain('…')
    expect(digest.length).toBeLessThan(1000)
  })
})
