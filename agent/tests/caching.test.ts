import { describe, expect, test } from 'bun:test'
import type { ModelInfo } from '@shared/types'
import { isExplicitCacheFamily, modelSupportsCaching, computeCacheSavings, applyCacheControl } from '../src/main/openrouter/caching'
import type { ChatMessage, ContentPart } from '../src/main/openrouter/client'

describe('isExplicitCacheFamily', () => {
  test('anthropic models need explicit cache_control', () => {
    expect(isExplicitCacheFamily('anthropic/claude-sonnet-5')).toBe(true)
  })
  test('qwen models need explicit cache_control', () => {
    expect(isExplicitCacheFamily('qwen/qwen3-coder-plus')).toBe(true)
  })
  test('alibaba-hosted deepseek-v3.2 needs explicit cache_control', () => {
    expect(isExplicitCacheFamily('deepseek/deepseek-v3.2')).toBe(true)
  })
  test('other models cache implicitly (no explicit marker needed)', () => {
    expect(isExplicitCacheFamily('openai/gpt-5.5')).toBe(false)
    expect(isExplicitCacheFamily('google/gemini-3-pro')).toBe(false)
    expect(isExplicitCacheFamily('x-ai/grok-4.5')).toBe(false)
  })
  test('non-allowlisted / snapshot Qwen endpoints do not support explicit caching', () => {
    // Per OpenRouter's docs, only a specific set of Alibaba-hosted Qwen models support explicit
    // cache_control — many qwen/* ids are hosted by other providers, and Alibaba's own snapshot
    // endpoints are explicitly excluded even though the base model does support it.
    expect(isExplicitCacheFamily('qwen/qwen3.5-plus-02-15')).toBe(false)
    expect(isExplicitCacheFamily('qwen/qwen3.5-flash-02-23')).toBe(false)
    expect(isExplicitCacheFamily('qwen/qwen3-embedding-8b')).toBe(false)
  })
})

describe('modelSupportsCaching', () => {
  const base: ModelInfo = {
    id: 'test/model',
    name: 'Test',
    contextLength: 100_000,
    promptPrice: 0.000001,
    completionPrice: 0.000005,
    cacheReadPrice: null,
    cacheWritePrice: null,
    supportsExplicitCaching: false,
    supportsTools: true,
    supportsReasoning: false,
    supportsVision: false,
    supportsEmbeddings: false
  }

  test('true when cacheReadPrice is set', () => {
    expect(modelSupportsCaching({ ...base, cacheReadPrice: 0.0000001 })).toBe(true)
  })
  test('false when cacheReadPrice is null', () => {
    expect(modelSupportsCaching(base)).toBe(false)
  })
})

describe('computeCacheSavings', () => {
  const model: ModelInfo = {
    id: 'test/model',
    name: 'Test',
    contextLength: 100_000,
    promptPrice: 0.000001, // $1/M
    completionPrice: 0.000005, // $5/M
    cacheReadPrice: 0.0000001, // $0.1/M
    cacheWritePrice: 0.00000125, // $1.25/M
    supportsExplicitCaching: true,
    supportsTools: true,
    supportsReasoning: false,
    supportsVision: false,
    supportsEmbeddings: false
  }

  test('no caching used: savings is zero', () => {
    const usage = { promptTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 100, costUsd: 0.0015 }
    const { costWithoutCacheUsd, cacheSavingsUsd } = computeCacheSavings(model, usage)
    expect(costWithoutCacheUsd).toBeCloseTo(0.0015, 10)
    expect(cacheSavingsUsd).toBeCloseTo(0, 10)
  })

  test('cache read hit: positive savings', () => {
    // 1000 prompt tokens, 900 of them cached reads, actual cost reflects the cheap cache-read rate
    const cachedTokens = 900
    const promptTokens = 1000
    const completionTokens = 100
    const actualCost =
      (promptTokens - cachedTokens) * model.promptPrice + cachedTokens * (model.cacheReadPrice ?? 0) + completionTokens * model.completionPrice
    const usage = { promptTokens, cachedTokens, cacheWriteTokens: 0, completionTokens, costUsd: actualCost }
    const { cacheSavingsUsd } = computeCacheSavings(model, usage)
    expect(cacheSavingsUsd).toBeGreaterThan(0)
  })

  test('pure cache-write turn: savings can be negative (write premium, no read benefit yet)', () => {
    const promptTokens = 1000
    const cacheWriteTokens = 1000
    const completionTokens = 100
    // Actual cost includes the write premium (1.25x) instead of the base prompt price
    const actualCost = cacheWriteTokens * (model.cacheWritePrice ?? model.promptPrice) + completionTokens * model.completionPrice
    const usage = { promptTokens, cachedTokens: 0, cacheWriteTokens, completionTokens, costUsd: actualCost }
    const { cacheSavingsUsd } = computeCacheSavings(model, usage)
    expect(cacheSavingsUsd).toBeLessThan(0)
  })
})

describe('applyCacheControl', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: 'How are you?' }
  ]

  test('no-op when disabled', () => {
    const out = applyCacheControl(messages, false, true)
    expect(out).toBe(messages)
  })

  test('marks system message and last message when enabled with breakpoint', () => {
    const out = applyCacheControl(messages, true, true)
    const system = out[0]
    expect(Array.isArray(system.content)).toBe(true)
    if (Array.isArray(system.content)) {
      expect(system.content[system.content.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    }

    const last = out[out.length - 1]
    expect(Array.isArray(last.content)).toBe(true)
    if (Array.isArray(last.content)) {
      expect(last.content[last.content.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    }

    // Middle messages should be untouched (content-wise; shallow copies are fine)
    expect(out[1]).toEqual(messages[1])
    expect(out[2]).toEqual(messages[2])
  })

  test('only marks system message when last-message breakpoint disabled', () => {
    const out = applyCacheControl(messages, true, false)
    const system = out[0]
    expect(Array.isArray(system.content)).toBe(true)

    const last = out[out.length - 1]
    expect(last.content).toBe(messages[3].content)
  })

  test('when trailingNote is given, the breakpoint moves to the second-to-last message and the true last message is left unmarked, note-only', () => {
    const out = applyCacheControl(messages, true, true, 'Current date/time: 12:00:00')

    // The true last message ("How are you?") gets ONLY the trailing note appended — no
    // cache_control marker, so its shape (note or no note) can freely change turn to turn without
    // ever destabilizing a cached breakpoint.
    const last = out[out.length - 1]
    expect(Array.isArray(last.content)).toBe(true)
    const lastParts = last.content as ContentPart[]
    expect(lastParts.length).toBe(2)
    expect(lastParts[0]).toEqual({ type: 'text', text: 'How are you?' })
    expect(lastParts[1]).toEqual({ type: 'text', text: 'Current date/time: 12:00:00' })

    // The message just before it ("Hi there!") gets the actual cache_control breakpoint instead —
    // this message's shape never changes across turns since nothing is ever appended to it.
    const breakpointMsg = out[out.length - 2]
    const bpParts = breakpointMsg.content as ContentPart[]
    expect(bpParts[bpParts.length - 1]).toEqual({ type: 'text', text: 'Hi there!', cache_control: { type: 'ephemeral' } })
  })

  test('trailingNote is still appended even when explicit caching is disabled (implicit-cache models still want it at the tail)', () => {
    const out = applyCacheControl(messages, false, true, 'Current date/time: 12:00:00')
    const last = out[out.length - 1]
    const parts = last.content as ContentPart[]
    expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'Current date/time: 12:00:00' })
    // System message must stay untouched (no cache_control) since caching is disabled.
    expect(out[0].content).toBe(messages[0].content)
  })

  // Regression test for the real "current date/time" bug, part 1 (mid-prefix poisoning): a live,
  // per-request-changing value was being placed BEFORE the growing conversation (either folded
  // into the system prompt, or as a separate early system message ahead of the messages array).
  // Since a cache_control breakpoint's hash covers the entire prefix up to and including it,
  // anything dynamic sitting earlier in that prefix poisons every breakpoint that follows. This
  // test simulates two consecutive turns (same history, new trailing message, only the live note
  // differs) and asserts everything up to and including the breakpoint message stays byte-for-byte
  // identical — only the reserved, never-marked, true-last message differs.
  test('a per-request-changing trailingNote never alters the growing, cacheable conversation prefix across turns', () => {
    const turn2Messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ]

    const outA = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:00:00')
    const outB = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:05:00')

    // Everything through the breakpoint message (second-to-last, since a trailingNote is given)
    // is completely unaffected by the live note.
    expect(outA.slice(0, -1)).toEqual(outB.slice(0, -1))

    // Only the reserved true-last message (note-only, never cache-marked) differs between the
    // two requests.
    const partsA = outA[outA.length - 1].content as ContentPart[]
    const partsB = outB[outB.length - 1].content as ContentPart[]
    expect(partsA[0]).toEqual(partsB[0])
    expect(partsA[1]).not.toEqual(partsB[1])
  })

  // Regression test for the real "current date/time" bug, part 2 (unstable breakpoint shape): even
  // after moving the note to the tail of the last message, that SAME message being both the note
  // carrier AND the cache_control breakpoint meant its shape differed between the turn it was
  // written (marked content + note) and every later turn it was replayed as history (just the
  // content, no note, since only the current turn's last message ever gets one) — silently
  // breaking cache matching for the whole conversation. The fix reserves the true last message
  // exclusively for the note and always marks the message one before it instead, so the marked
  // message's shape never changes across turns regardless of whether a note is present this call.
  test('the breakpoint message is never the same message the trailingNote is appended to, so its shape never changes across turns', () => {
    const turn2Messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ]
    const out = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:00:00')

    // "Hi there!" (index 2, second-to-last) carries the breakpoint...
    const breakpointParts = out[2].content as ContentPart[]
    expect(breakpointParts).toEqual([{ type: 'text', text: 'Hi there!', cache_control: { type: 'ephemeral' } }])

    // ...and once this exact message is replayed as history on a later turn (no longer last,
    // no trailingNote appended to it, freshly rebuilt from storage), re-marking it produces the
    // exact same shape/content — the breakpoint the model needs to match against.
    const laterTurnMessages: ChatMessage[] = [...turn2Messages, { role: 'assistant', content: 'Doing well!' }, { role: 'user', content: 'Great' }]
    const outLater = applyCacheControl(laterTurnMessages, true, true, 'Current date/time: 12:10:00', 2)
    expect(outLater[2].content).toEqual(breakpointParts)
  })

  // Regression test for the "cached_tokens never grows past the system prompt" bug: relying on
  // OpenRouter to find a non-system breakpoint via implicit cross-request lookback never actually
  // produced a read hit in practice (see the `[cache]` log evidence in client.ts's history), so
  // every turn re-wrote the entire conversation-since-system from scratch. Explicitly re-marking
  // the previous turn's breakpoint position fixes this by giving every request a direct hit.
  test('priorBreakpointIdx re-marks the previous turn\'s breakpoint in addition to the new one', () => {
    const longer: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'tool', content: 'tool result 1', tool_call_id: 'a' },
      { role: 'assistant', content: 'Following up' },
      { role: 'user', content: 'Great, one more thing' }
    ]
    // No trailingNote here, so the breakpoint sits on the true last message (index 5) — simulate
    // turn 3, where turn 2 marked index 3 (a tool result) as its own breakpoint.
    const out = applyCacheControl(longer, true, true, undefined, 3)

    const marked = out
      .map((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.cache_control) ? i : -1))
      .filter((i) => i >= 0)
    // system (0), the carried-forward prior breakpoint (3), and the new last message (5).
    expect(marked).toEqual([0, 3, 5])
  })

  test('priorBreakpointIdx is ignored when it points at the system message or the current last message', () => {
    const out1 = applyCacheControl(messages, true, true, undefined, 0)
    const marked1 = out1
      .map((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.cache_control) ? i : -1))
      .filter((i) => i >= 0)
    expect(marked1).toEqual([0, messages.length - 1])

    const out2 = applyCacheControl(messages, true, true, undefined, messages.length - 1)
    const marked2 = out2
      .map((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.cache_control) ? i : -1))
      .filter((i) => i >= 0)
    expect(marked2).toEqual([0, messages.length - 1])
  })

  test('priorBreakpointIdx is ignored when it points at the reserved trailingNote slot', () => {
    const turn2Messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ]
    // Pretend a stale prior breakpoint pointed at the true-last (reserved, note-only) slot.
    const out = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:00:00', turn2Messages.length - 1)
    const marked = out
      .map((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.cache_control) ? i : -1))
      .filter((i) => i >= 0)
    // system (0) and the breakpoint (2) only — the reserved last slot (3) must never get marked.
    expect(marked).toEqual([0, 2])
  })
})
