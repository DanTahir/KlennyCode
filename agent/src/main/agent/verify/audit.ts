// Glue between the pure detector (fabrication-detector.ts) and the turn loop: assembles the
// detector's inputs from a finished assistant message, applies the user's enforcement tier, and
// builds the audit note that gets injected back into the conversation.
//
// Kept separate from loop.ts so the tier logic and note construction are unit-testable without
// standing up a whole streaming turn, and separate from the detector so the detector stays pure
// (no settings, no ChatMessage shape, no workspace resolution).
import type { ChatMessage, ChecklistItem, FabricationFinding } from '@shared/types'
import { nanoid } from 'nanoid'
import { buildTurnLedger, buildSessionWritePaths, buildLedgerDigest } from '../orchestrator/ledger'
import { detectFabrication, buildAuditNote, type DetectorContextKind } from './fabrication-detector'

export type FabricationGuardMode = 'off' | 'warn' | 'enforce'

export interface AuditOutcome {
  status: 'clean' | 'warned' | 'disputed'
  findings: FabricationFinding[]
  /** True only when hard findings were produced AND the guard is in 'enforce' mode. */
  forceCorrection: boolean
  /** The ledger digest as it stood when the audit ran — reused verbatim in the audit note so the
   *  model sees exactly the evidence the verdict was based on. */
  ledgerDigest: string
}

/** Maximum forced self-correction turns before giving up with 'audit_failed'. Two is enough for
 *  the model to retract and either do the work or admit it didn't; more than that is a loop
 *  burning tokens on a model that isn't going to comply. */
export const MAX_AUDIT_CORRECTIONS = 2

function textOf(msg: ChatMessage, type: 'text' | 'thinking'): string {
  return msg.blocks
    .filter((b): b is { type: 'text' | 'thinking'; text: string } => b.type === type)
    .map((b) => b.text)
    .join('\n')
}

function toolCallCountOf(msg: ChatMessage): number {
  return msg.blocks.filter((b) => b.type === 'tool_call').length
}

/**
 * Audits one finished assistant message.
 *
 * `messages` must already include `assistantMsg` with its tool_call blocks recorded — the ledger
 * is intentionally computed here, at audit time, rather than being passed in from before the
 * stream: a pre-stream snapshot wouldn't contain this message's own calls, so the first honest
 * "I ran X" in a turn would be flagged as unsupported.
 */
export function auditAssistantMessage(opts: {
  assistantMsg: ChatMessage
  messages: ChatMessage[]
  guard: FabricationGuardMode
  contextKind: DetectorContextKind
  root?: string
  activeChecklist?: { title: string; items: ChecklistItem[] }
  knownToolNames: readonly string[]
  /** injected for tests; defaults to real wall clock */
  nowMs?: number
  fileExists?: (absPath: string) => boolean
}): AuditOutcome {
  const turnLedger = buildTurnLedger(opts.messages)
  const ledgerDigest = buildLedgerDigest(turnLedger)

  if (opts.guard === 'off') {
    return { status: 'clean', findings: [], forceCorrection: false, ledgerDigest }
  }

  const { hard, soft } = detectFabrication({
    text: textOf(opts.assistantMsg, 'text'),
    thinking: textOf(opts.assistantMsg, 'thinking'),
    thisMessageToolCallCount: toolCallCountOf(opts.assistantMsg),
    turnLedger,
    sessionWritePaths: buildSessionWritePaths(opts.messages),
    nowMs: opts.nowMs ?? Date.now(),
    activeChecklist: opts.activeChecklist,
    root: opts.root,
    fileExists: opts.fileExists,
    knownToolNames: opts.knownToolNames,
    contextKind: opts.contextKind
  })

  // 'warn' keeps every finding visible but never forces a correction turn — the escape hatch for
  // users who want the signal without the interruption, which is strictly better than them
  // turning the whole guard off.
  if (opts.guard === 'warn') {
    const all = [...hard, ...soft]
    return {
      status: all.length > 0 ? 'warned' : 'clean',
      findings: all,
      forceCorrection: false,
      ledgerDigest
    }
  }

  if (hard.length > 0) {
    // Soft findings ride along in the report: once a message is disputed anyway, the extra context
    // helps the model understand the full picture of what looked wrong.
    return { status: 'disputed', findings: [...hard, ...soft], forceCorrection: true, ledgerDigest }
  }
  if (soft.length > 0) {
    return { status: 'warned', findings: soft, forceCorrection: false, ledgerDigest }
  }
  return { status: 'clean', findings: [], forceCorrection: false, ledgerDigest }
}

/**
 * The synthetic message injected to force a self-correction.
 *
 * `role: 'user'` is required rather than preferred: toORMessages() only emits system messages for
 * the prompt/summary prefix, so a 'system'-role entry mid-history would never reach the model at
 * all. `isAuditNote` is what keeps it from being mistaken for real user input — see its doc
 * comment in shared/types.ts and the turn-boundary walk in orchestrator/ledger.ts.
 */
export function buildAuditNoteMessage(outcome: AuditOutcome): ChatMessage {
  return {
    id: nanoid(),
    role: 'user',
    blocks: [{ type: 'text', text: buildAuditNote(outcome.findings, outcome.ledgerDigest) }],
    createdAt: Date.now(),
    isAuditNote: true
  }
}

/**
 * Warning block appended to a subagent summary or a delivered scheduled-task result. Those
 * contexts get no correction loop — a subagent has no UI to click Continue and a fixed budget, and
 * a scheduled run is one-shot — so surfacing the findings to whoever reads the output is the only
 * available remedy.
 */
export function buildFindingsWarningBlock(findings: FabricationFinding[]): string {
  if (findings.length === 0) return ''
  const lines = findings.map((f) => `- [${f.code}] ${f.detail}`)
  return [
    '',
    '---',
    '⚠ UNVERIFIED CLAIMS — the fabrication guard found statements above that contradict the harness\'s own execution records:',
    ...lines,
    '',
    'Treat the affected claims as unproven until independently checked.'
  ].join('\n')
}
