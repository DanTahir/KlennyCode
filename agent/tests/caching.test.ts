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

  test('trailingNote is appended as a new, uncached part after the last message\'s own (marked) content', () => {
    const out = applyCacheControl(messages, true, true, 'Current date/time: 12:00:00')
    const last = out[out.length - 1]
    expect(Array.isArray(last.content)).toBe(true)
    const parts = last.content as ContentPart[]
    expect(parts.length).toBe(2)
    // The real content keeps the cache_control marker...
    expect(parts[0]).toEqual({ type: 'text', text: 'How are you?', cache_control: { type: 'ephemeral' } })
    // ...and the note trails after it, unmarked.
    expect(parts[1]).toEqual({ type: 'text', text: 'Current date/time: 12:00:00' })
  })

  test('trailingNote is still appended even when explicit caching is disabled (implicit-cache models still want it at the tail)', () => {
    const out = applyCacheControl(messages, false, true, 'Current date/time: 12:00:00')
    const last = out[out.length - 1]
    const parts = last.content as ContentPart[]
    expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'Current date/time: 12:00:00' })
    // System message must stay untouched (no cache_control) since caching is disabled.
    expect(out[0].content).toBe(messages[0].content)
  })

  // Regression test for the real "current date/time" bug: a live, per-request-changing value
  // was being placed BEFORE the growing conversation (either folded into the system prompt, or
  // even just as a separate early system message ahead of the messages array). Since a
  // cache_control breakpoint's hash covers the *entire* prefix up to and including it, anything
  // dynamic sitting earlier in that prefix poisons every breakpoint that follows — so only the
  // system block ever cached, and the growing history never did. The fix appends the note strictly
  // AFTER the last message's own cache_control marker, so it never becomes part of any cached
  // prefix. This test simulates two consecutive turns (same history, new trailing message, only
  // the live note differs) and asserts everything up to the newest message — including the
  // *previous* turn's cache breakpoint — stays byte-for-byte identical.
  test('a per-request-changing trailingNote never alters the growing, cacheable conversation prefix across turns', () => {
    const turn2Messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ]

    const outA = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:00:00')
    const outB = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:05:00')

    // Everything up through the second-to-last message (i.e. what turn 3 would replay as
    // untouched history) is completely unaffected by the live note.
    expect(outA.slice(0, -1)).toEqual(outB.slice(0, -1))

    // Even on the shared last message, the actual cache-marked content is identical between the
    // two requests — only the trailing, uncached note differs.
    const partsA = outA[outA.length - 1].content as ContentPart[]
    const partsB = outB[outB.length - 1].content as ContentPart[]
    expect(partsA[0]).toEqual(partsB[0])
    expect(partsA[1]).not.toEqual(partsB[1])
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
    // Simulate turn 3: turn 2 marked index 3 (a tool result) as its own "last message" breakpoint.
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
})
