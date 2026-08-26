import { describe, expect, test } from 'bun:test'

import {
  auditAssistantMessage,
  buildAuditNoteMessage,
  buildFindingsWarningBlock,
  MAX_AUDIT_CORRECTIONS
} from '../src/main/agent/verify/audit'
import type { ChatMessage, ToolCallBlock } from '@shared/types'

const NOW = new Date(2026, 0, 15, 14, 16, 31).getTime()
const KNOWN_TOOLS = ['run_command', 'write_file', 'read_file', 'update_checklist'] as const

function userMsg(text = 'build it'): ChatMessage {
  return { id: 'u1', role: 'user', blocks: [{ type: 'text', text }], createdAt: NOW - 600_000 }
}

function assistantMsg(text: string, calls: ToolCallBlock[] = []): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'text', text } as const, ...calls],
    createdAt: NOW
  }
}

function audit(
  text: string,
  guard: 'off' | 'warn' | 'enforce',
  over: { calls?: ToolCallBlock[]; fileExists?: boolean } = {}
) {
  const a = assistantMsg(text, over.calls ?? [])
  return auditAssistantMessage({
    assistantMsg: a,
    messages: [userMsg(), a],
    guard,
    contextKind: 'project-agent',
    root: '/repo',
    knownToolNames: KNOWN_TOOLS,
    nowMs: NOW,
    fileExists: () => over.fileExists ?? false
  })
}

// A hard finding: claims a file was created that no write tool touched and that doesn't exist.
const HARD_TEXT = 'I created warehouse-allocator/manage.py with the standard scaffold.'
// A soft finding only: first-person claim of a tool that never ran.
const SOFT_TEXT = 'I called update_checklist to mark that step done.'

describe('enforcement tiers', () => {
  test("'off' short-circuits entirely — no findings even for a blatant fabrication", () => {
    const r = audit(HARD_TEXT, 'off')
    expect(r.status).toBe('clean')
    expect(r.findings).toHaveLength(0)
    expect(r.forceCorrection).toBe(false)
  })

  test("'warn' reports hard findings but never forces a correction", () => {
    const r = audit(HARD_TEXT, 'warn')
    expect(r.status).toBe('warned')
    expect(r.findings.length).toBeGreaterThan(0)
    expect(r.forceCorrection).toBe(false)
  })

  test("'enforce' disputes hard findings and forces a correction", () => {
    const r = audit(HARD_TEXT, 'enforce')
    expect(r.status).toBe('disputed')
    expect(r.forceCorrection).toBe(true)
    expect(r.findings.some((f) => f.code === 'C3')).toBe(true)
  })

  test("'enforce' only warns (never forces) when findings are soft", () => {
    const r = audit(SOFT_TEXT, 'enforce')
    expect(r.status).toBe('warned')
    expect(r.forceCorrection).toBe(false)
    expect(r.findings.every((f) => f.severity === 'soft')).toBe(true)
  })

  test('a clean message stays clean under enforce', () => {
    const r = audit('Here is how the orchestrator is laid out. Want me to start?', 'enforce')
    expect(r.status).toBe('clean')
    expect(r.forceCorrection).toBe(false)
  })

  test('the ledger digest is always returned, even when the guard is off', () => {
    expect(audit(HARD_TEXT, 'off').ledgerDigest).toContain('NONE')
    expect(audit(HARD_TEXT, 'enforce').ledgerDigest).toContain('NONE')
  })
})

describe('ledger is computed at audit time (includes this message own calls)', () => {
  test("a real write in the same message suppresses the artifact finding", () => {
    const calls: ToolCallBlock[] = [
      {
        type: 'tool_call',
        id: 't1',
        toolName: 'write_file',
        args: { path: 'warehouse-allocator/manage.py' },
        status: 'success'
      }
    ]
    const r = audit(HARD_TEXT, 'enforce', { calls })
    expect(r.status).toBe('clean')
  })

  test('the digest reflects calls made by the message under audit', () => {
    const calls: ToolCallBlock[] = [
      { type: 'tool_call', id: 't1', toolName: 'run_command', args: { command: 'ls' }, status: 'success' }
    ]
    const r = audit('Listed the directory.', 'enforce', { calls })
    expect(r.ledgerDigest).toContain('run_command')
    expect(r.ledgerDigest).not.toContain('NONE')
  })
})

describe('audit note message', () => {
  test('is a user-role message flagged isAuditNote so it is not a turn boundary', () => {
    const outcome = audit(HARD_TEXT, 'enforce')
    const note = buildAuditNoteMessage(outcome)
    expect(note.role).toBe('user')
    expect(note.isAuditNote).toBe(true)
    const text = note.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toContain('AUTOMATED VERIFICATION NOTICE')
    expect(text).toContain('manage.py')
  })

  test('carries the ledger digest so the model sees the evidence behind the verdict', () => {
    const outcome = audit(HARD_TEXT, 'enforce')
    const text = buildAuditNoteMessage(outcome)
      .blocks.map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
    expect(text).toContain(outcome.ledgerDigest)
  })
})

describe('findings warning block (subagent / scheduled output)', () => {
  test('is empty for no findings', () => {
    expect(buildFindingsWarningBlock([])).toBe('')
  })

  test('lists each finding code and detail', () => {
    const block = buildFindingsWarningBlock([
      { code: 'C1', severity: 'hard', detail: 'future timestamp' },
      { code: 'C3', severity: 'hard', detail: 'missing file' }
    ])
    expect(block).toContain('UNVERIFIED CLAIMS')
    expect(block).toContain('[C1] future timestamp')
    expect(block).toContain('[C3] missing file')
  })
})

test('correction budget is small and finite', () => {
  expect(MAX_AUDIT_CORRECTIONS).toBe(2)
})
