import { describe, expect, test } from 'bun:test'
import { toORMessages } from '../src/main/agent/messages'
import { mergeReasoningDetails } from '../src/main/openrouter/client'
import type { ChatMessage } from '@shared/types'

/**
 * Regression tests for the reasoning round-trip fix.
 *
 * Background: `toORMessages` used to concatenate `thinking` blocks into the assistant message's
 * `content`, which replayed the model's private reasoning back to it as though it had been spoken
 * aloud. Beyond being wrong on the wire, it turned the conversation history into a few-shot
 * demonstration of "think a paragraph, say a sentence, make exactly one tool call" — the serial
 * tool-calling rhythm we were trying to eliminate. Reasoning now travels in the dedicated
 * `reasoning`/`reasoning_details` wire fields instead.
 */

function userMsg(id: string, text: string): ChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt: Date.now() }
}

function assistantMsg(
  id: string,
  opts: {
    text?: string
    thinking?: string
    reasoningDetails?: Array<Record<string, unknown>>
    toolCalls?: Array<{ id: string; toolName: string }>
  }
): ChatMessage {
  const blocks: ChatMessage['blocks'] = []
  if (opts.thinking) blocks.push({ type: 'thinking', text: opts.thinking })
  if (opts.text) blocks.push({ type: 'text', text: opts.text })
  for (const tc of opts.toolCalls ?? []) {
    blocks.push({ type: 'tool_call', id: tc.id, toolName: tc.toolName, args: {}, status: 'success' })
  }
  return {
    id,
    role: 'assistant',
    blocks,
    createdAt: Date.now(),
    ...(opts.reasoningDetails ? { reasoningDetails: opts.reasoningDetails as never } : {})
  }
}

function toolResultMsg(id: string, toolCallId: string, toolName: string): ChatMessage {
  return {
    id,
    role: 'tool',
    blocks: [
      {
        type: 'tool_call',
        id: toolCallId,
        toolName,
        args: {},
        status: 'success',
        result: { ok: true, summary: `${toolName} done` }
      }
    ],
    createdAt: Date.now()
  }
}

describe('toORMessages — thinking is never merged into assistant content', () => {
  test('assistant content contains only spoken text, not the thinking block', () => {
    const messages: ChatMessage[] = [
      userMsg('u0', 'read two files'),
      assistantMsg('a0', {
        thinking: 'SECRET_REASONING: I should read both files at once.',
        text: 'Reading both files.',
        toolCalls: [{ id: 'tc1', toolName: 'read_file' }]
      })
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const asst = or.find((m) => m.role === 'assistant')
    expect(asst).toBeDefined()
    expect(asst!.content).toBe('Reading both files.')
    expect(String(asst!.content)).not.toContain('SECRET_REASONING')
  })

  test('thinking is carried in the `reasoning` field instead of being dropped', () => {
    const messages: ChatMessage[] = [
      userMsg('u0', 'go'),
      assistantMsg('a0', { thinking: 'my private reasoning', text: 'Done.' })
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const asst = or.find((m) => m.role === 'assistant')
    expect(asst!.reasoning).toBe('my private reasoning')
    expect(asst!.content).toBe('Done.')
  })

  test('a text-only assistant turn carries no reasoning fields at all', () => {
    const messages: ChatMessage[] = [userMsg('u0', 'go'), assistantMsg('a0', { text: 'Done.' })]
    const or = toORMessages(messages, 'SYSTEM')
    const asst = or.find((m) => m.role === 'assistant')
    expect(asst!.reasoning).toBeUndefined()
    expect(asst!.reasoning_details).toBeUndefined()
  })
})

describe('toORMessages — structured reasoning_details take precedence', () => {
  test('captured provider blocks are replayed verbatim, and the plaintext fallback is not used', () => {
    // Structured blocks may carry signatures; the flattened plaintext copy would destroy them,
    // so when both exist the structured form must win.
    const details = [{ type: 'reasoning.encrypted', data: 'OPAQUE_BLOB', id: 'r1' }]
    const messages: ChatMessage[] = [
      userMsg('u0', 'go'),
      assistantMsg('a0', {
        thinking: 'plaintext shadow copy',
        text: 'Done.',
        reasoningDetails: details
      })
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const asst = or.find((m) => m.role === 'assistant')
    expect(asst!.reasoning_details).toEqual(details)
    expect(asst!.reasoning).toBeUndefined()
  })

  test('reasoning fields ride along with tool_calls (the case that matters for continuity)', () => {
    const details = [{ type: 'reasoning.text', text: 'step one' }]
    const messages: ChatMessage[] = [
      userMsg('u0', 'go'),
      assistantMsg('a0', {
        reasoningDetails: details,
        toolCalls: [{ id: 'tc1', toolName: 'read_file' }]
      })
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const asst = or.find((m) => m.role === 'assistant')
    expect(asst!.tool_calls).toHaveLength(1)
    expect(asst!.reasoning_details).toEqual(details)
  })

  test('an empty reasoningDetails array falls back to plaintext rather than sending nothing', () => {
    const messages: ChatMessage[] = [
      userMsg('u0', 'go'),
      assistantMsg('a0', { thinking: 'fallback text', text: 'Done.', reasoningDetails: [] })
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const asst = or.find((m) => m.role === 'assistant')
    expect(asst!.reasoning).toBe('fallback text')
  })
})

describe('toORMessages — consecutive tool results stay consecutive', () => {
  test('three parallel tool calls produce three adjacent tool messages with no interleaving', () => {
    // Anthropic documents splitting batched tool results across separate/interleaved messages as
    // the single most common cause of degraded parallel tool use: the model infers from its own
    // history that results arrive one at a time, and reverts to one call per turn. Our wire output
    // must therefore keep them strictly adjacent.
    const messages: ChatMessage[] = [
      userMsg('u0', 'read three files'),
      assistantMsg('a0', {
        text: 'Reading all three.',
        toolCalls: [
          { id: 'tc1', toolName: 'read_file' },
          { id: 'tc2', toolName: 'read_file' },
          { id: 'tc3', toolName: 'read_file' }
        ]
      }),
      toolResultMsg('t1', 'tc1', 'read_file'),
      toolResultMsg('t2', 'tc2', 'read_file'),
      toolResultMsg('t3', 'tc3', 'read_file')
    ]
    const or = toORMessages(messages, 'SYSTEM')

    const firstToolIdx = or.findIndex((m) => m.role === 'tool')
    expect(firstToolIdx).toBeGreaterThan(-1)
    const toolRun = or.slice(firstToolIdx, firstToolIdx + 3)
    expect(toolRun.map((m) => m.role)).toEqual(['tool', 'tool', 'tool'])
    expect(toolRun.map((m) => m.tool_call_id)).toEqual(['tc1', 'tc2', 'tc3'])

    // The assistant message immediately before them must carry all three calls together.
    const asst = or[firstToolIdx - 1]
    expect(asst.role).toBe('assistant')
    expect(asst.tool_calls?.map((tc) => tc.id)).toEqual(['tc1', 'tc2', 'tc3'])

    // And nothing non-tool may appear inside the run.
    const totalToolMsgs = or.filter((m) => m.role === 'tool').length
    expect(totalToolMsgs).toBe(3)
  })
})

describe('mergeReasoningDetails — streaming delta accumulation', () => {
  test('concatenates text fragments belonging to the same (index, type) block', () => {
    const acc: Array<Record<string, unknown>> = []
    mergeReasoningDetails(acc as never, [{ type: 'reasoning.text', text: 'Hello ', index: 0 }])
    mergeReasoningDetails(acc as never, [{ type: 'reasoning.text', text: 'world', index: 0 }])
    expect(acc).toHaveLength(1)
    expect(acc[0].text).toBe('Hello world')
  })

  test('keeps distinct blocks separate and preserves arrival order', () => {
    const acc: Array<Record<string, unknown>> = []
    mergeReasoningDetails(acc as never, [{ type: 'reasoning.text', text: 'first', index: 0 }])
    mergeReasoningDetails(acc as never, [{ type: 'reasoning.summary', summary: 'second', index: 1 }])
    expect(acc).toHaveLength(2)
    expect(acc[0].type).toBe('reasoning.text')
    expect(acc[1].summary).toBe('second')
  })

  test('non-text fields (signatures, ids) are replaced wholesale, never concatenated', () => {
    const acc: Array<Record<string, unknown>> = []
    mergeReasoningDetails(acc as never, [{ type: 'reasoning.encrypted', data: 'AA', signature: 'sig-partial', index: 0 }])
    mergeReasoningDetails(acc as never, [{ type: 'reasoning.encrypted', data: 'BB', signature: 'sig-final', index: 0 }])
    expect(acc).toHaveLength(1)
    // `data` is a text-bearing field and accumulates...
    expect(acc[0].data).toBe('AABB')
    // ...but a signature is a whole value; concatenating it would corrupt it.
    expect(acc[0].signature).toBe('sig-final')
  })

  test('tolerates malformed deltas without throwing or polluting the accumulator', () => {
    const acc: Array<Record<string, unknown>> = []
    mergeReasoningDetails(acc as never, undefined)
    mergeReasoningDetails(acc as never, 'not-an-array')
    mergeReasoningDetails(acc as never, [null, 'junk', 42])
    expect(acc).toHaveLength(0)
  })

  test('unrecognized fields are carried through rather than dropped', () => {
    // OpenRouter requires the replayed sequence to match what the model produced, so an unknown
    // provider-specific field must survive the round-trip.
    const acc: Array<Record<string, unknown>> = []
    mergeReasoningDetails(acc as never, [{ type: 'reasoning.text', text: 'x', vendor_extra: { a: 1 } }])
    expect(acc[0].vendor_extra).toEqual({ a: 1 })
  })
})
