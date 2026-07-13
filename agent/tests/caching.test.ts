import { describe, expect, test } from 'bun:test'
import type { ModelInfo } from '@shared/types'
import { isExplicitCacheFamily, modelSupportsCaching, computeCacheSavings, applyCacheControl } from '../src/main/openrouter/caching'
import type { ChatMessage } from '../src/main/openrouter/client'

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
})
