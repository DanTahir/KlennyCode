import { describe, expect, test, mock } from 'bun:test'

mock.module('../src/main/openrouter/client', () => ({
  summarizeMessages: async (_apiKey: string, _model: string, transcript: string) => `SUMMARY OF: ${transcript.slice(0, 50)}`
}))

import { maybeCompact } from '../src/main/agent/compaction/compactor'
import { toORMessages, messagesForWire } from '../src/main/agent/messages'
import type { ChatMessage, ModelInfo } from '@shared/types'

const model: ModelInfo = {
  id: 'test/model',
  name: 'Test Model',
  contextLength: 1_000_000,
  promptPrice: 0,
  completionPrice: 0,
  cacheReadPrice: null,
  cacheWritePrice: null,
  supportsExplicitCaching: false,
  supportsReasoning: false,
  supportedReasoningEfforts: [],
  maxCompletionTokens: null
} as unknown as ModelInfo

function userMsg(id: string, text: string): ChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt: Date.now() }
}

function assistantMsg(
  id: string,
  text: string,
  usage?: { promptTokens: number; completionTokens: number }
): ChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text }],
    createdAt: Date.now(),
    usage: usage
      ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, cachedTokens: 0, cacheWriteTokens: 0, costUsd: 0, costWithoutCacheUsd: 0 }
      : undefined
  }
}

let buildMessagesCounter = 0

function buildMessages(n: number): ChatMessage[] {
  const out: ChatMessage[] = []
  const batch = buildMessagesCounter++
  for (let i = 0; i < n; i++) {
    out.push(userMsg(`u${batch}_${i}`, `question ${i}`))
    out.push(assistantMsg(`a${batch}_${i}`, `answer ${i}`, { promptTokens: 1000, completionTokens: 50 }))
  }
  return out
}

describe('maybeCompact', () => {
  test('does nothing when under threshold', async () => {
    const messages = buildMessages(3)
    const result = await maybeCompact({
      messages,
      model,
      apiKey: 'k',
      utilityModel: 'test/model',
      models: [model]
    })
    expect(result.compacted).toBe(false)
  })

  test('uses real usage.promptTokens instead of the char heuristic to decide when to compact', async () => {
    // Tiny text bodies (heuristic would estimate near-zero tokens) but a huge reported
    // promptTokens on the latest message — this should trigger compaction even though the
    // char-count heuristic alone would never cross the threshold.
    const messages = [
      ...buildMessages(20),
      assistantMsg('a_last', 'ok', { promptTokens: 900_000, completionTokens: 10 })
    ]
    const result = await maybeCompact({
      messages,
      model,
      apiKey: 'k',
      utilityModel: 'test/model',
      models: [model]
    })
    expect(result.compacted).toBe(true)
    expect(result.compactedThroughMessageId).toBeDefined()
    expect(result.summary).toBeDefined()
  })

  test('falls back to the char-heuristic (including tool results) when no usage is present', async () => {
    // compactToolResult caps any single tool result's JSON at 40k chars, so use several tool
    // calls (each independently capped) to still add up to well past the 200k-token threshold
    // once /4'd, proving tool-call results are actually counted by the heuristic.
    const bigResult = { ok: true, summary: 'big', data: { text: 'x'.repeat(200_000) } }
    const toolPairs: ChatMessage[] = []
    for (let i = 0; i < 30; i++) {
      toolPairs.push({
        id: `a_tool${i}`,
        role: 'assistant',
        blocks: [{ type: 'tool_call', id: `tc${i}`, toolName: 'read_file', args: { path: `foo${i}.ts` }, status: 'success' }],
        createdAt: Date.now()
      })
      toolPairs.push({
        id: `t${i}`,
        role: 'tool',
        blocks: [{ type: 'tool_call', id: `tc${i}`, toolName: 'read_file', args: { path: `foo${i}.ts` }, status: 'success', result: bigResult }],
        createdAt: Date.now()
      })
    }
    const messages: ChatMessage[] = [userMsg('u0', 'read these files'), ...toolPairs]
    const result = await maybeCompact({
      messages,
      model,
      apiKey: 'k',
      utilityModel: 'test/model',
      models: [model]
    })
    expect(result.compacted).toBe(true)
  })

  test('never mutates or drops messages — caller decides what to keep visible', async () => {
    const messages = [
      ...buildMessages(20),
      assistantMsg('a_last', 'ok', { promptTokens: 900_000, completionTokens: 10 })
    ]
    const before = messages.length
    await maybeCompact({ messages, model, apiKey: 'k', utilityModel: 'test/model', models: [model] })
    expect(messages.length).toBe(before)
  })

  test('a second compaction pass only re-summarizes the tail after the prior cutoff', async () => {
    const messages = [
      ...buildMessages(20),
      assistantMsg('a_last', 'ok', { promptTokens: 900_000, completionTokens: 10 })
    ]
    const first = await maybeCompact({ messages, model, apiKey: 'k', utilityModel: 'test/model', models: [model] })
    expect(first.compacted).toBe(true)

    const more = [
      ...messages,
      ...buildMessages(10),
      userMsg('u_new', 'more'),
      assistantMsg('a_new', 'more ok', { promptTokens: 950_000, completionTokens: 10 })
    ]
    const second = await maybeCompact({
      messages: more,
      model,
      apiKey: 'k',
      utilityModel: 'test/model',
      models: [model],
      priorSummary: first.summary,
      priorCompactedThroughMessageId: first.compactedThroughMessageId
    })
    expect(second.compacted).toBe(true)
    // The new cutoff must be at or after the prior one (never regresses).
    const idxFirst = more.findIndex((m) => m.id === first.compactedThroughMessageId)
    const idxSecond = more.findIndex((m) => m.id === second.compactedThroughMessageId)
    expect(idxSecond).toBeGreaterThanOrEqual(idxFirst)
  })
})

describe('messagesForWire + toORMessages (history untouched, summary injected only for the wire)', () => {
  test('messagesForWire returns everything when no cutoff is set', () => {
    const messages = buildMessages(3)
    expect(messagesForWire(messages)).toBe(messages)
  })

  test('messagesForWire drops the compacted prefix but the original array is untouched', () => {
    const messages = buildMessages(5)
    const cutoffId = messages[3].id
    const wire = messagesForWire(messages, cutoffId)
    expect(wire.length).toBe(messages.length - 4)
    expect(wire[0].id).toBe(messages[4].id)
    // Original full history is unaffected.
    expect(messages.length).toBe(10)
  })

  test('toORMessages injects the compaction summary as a system message ahead of the remaining messages', () => {
    const messages = buildMessages(2)
    const or = toORMessages(messages, 'SYSTEM PROMPT', 'earlier stuff happened')
    expect(or[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' })
    expect(or[1].role).toBe('system')
    expect(String(or[1].content)).toContain('earlier stuff happened')
  })

  test('toORMessages omits the summary system message when none is given', () => {
    const messages = buildMessages(1)
    const or = toORMessages(messages, 'SYSTEM PROMPT')
    expect(or.filter((m) => m.role === 'system').length).toBe(1)
  })
})
