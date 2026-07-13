import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ModelInfo, TabSession, ToolCallBlock } from '@shared/types'
import { resolveReasoningEffort } from '../src/main/agent/reasoning'

const baseModel: ModelInfo = {
  id: 'test/model',
  name: 'Test',
  contextLength: 100_000,
  promptPrice: 0.000001,
  completionPrice: 0.000005,
  cacheReadPrice: null,
  cacheWritePrice: null,
  supportsExplicitCaching: false,
  supportsTools: true,
  supportsReasoning: true,
  supportsVision: false,
  supportsEmbeddings: false
}

function makeTab(messages: ChatMessage[], mode: 'agent' | 'plan' = 'agent'): TabSession {
  return {
    id: 'tab1',
    title: 'Test',
    mode,
    model: baseModel.id,
    createdAt: 0,
    updatedAt: 0,
    messages,
    totalCostUsd: 0
  }
}

function toolCallMessage(toolName: string, args: Record<string, unknown>, ok: boolean, role: 'assistant' | 'tool' = 'tool'): ChatMessage {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: `${toolName}_${Math.random()}`,
    toolName,
    args,
    status: ok ? 'success' : 'error',
    result: { ok, summary: 'x' }
  }
  return { id: `m_${Math.random()}`, role, blocks: [block], createdAt: 0 }
}

function userMessage(text: string): ChatMessage {
  return { id: `m_${Math.random()}`, role: 'user', blocks: [{ type: 'text', text }], createdAt: 0 }
}

describe('resolveReasoningEffort', () => {
  test('returns undefined when the model does not support reasoning', () => {
    const tab = makeTab([userMessage('hi')])
    expect(resolveReasoningEffort(tab, { ...baseModel, supportsReasoning: false })).toBeUndefined()
  })

  test('empty history falls back to a baseline level (medium or low)', () => {
    const tab = makeTab([])
    const effort = resolveReasoningEffort(tab, baseModel)
    expect(['low', 'medium']).toContain(effort)
  })

  test('plan mode biases toward higher effort than agent mode for identical input', () => {
    const messages = [userMessage('do a thing')]
    const agentEffort = resolveReasoningEffort(makeTab(messages, 'agent'), baseModel)
    const planEffort = resolveReasoningEffort(makeTab(messages, 'plan'), baseModel)
    const order = { low: 0, medium: 1, high: 2 } as const
    expect(order[planEffort!]).toBeGreaterThanOrEqual(order[agentEffort!])
  })

  test('a failed last tool result escalates effort vs. an otherwise-identical success', () => {
    const failing = makeTab([toolCallMessage('read_file', { path: 'a.ts' }, false)])
    const succeeding = makeTab([toolCallMessage('read_file', { path: 'a.ts' }, true)])
    const order = { low: 0, medium: 1, high: 2 } as const
    expect(order[resolveReasoningEffort(failing, baseModel)!]).toBeGreaterThan(
      order[resolveReasoningEffort(succeeding, baseModel)!]
    )
  })

  test('3x repeated identical tool call forces high', () => {
    const args = { path: 'a.ts' }
    const tab = makeTab([
      toolCallMessage('read_file', args, true),
      toolCallMessage('read_file', args, true),
      toolCallMessage('read_file', args, true)
    ])
    expect(resolveReasoningEffort(tab, baseModel)).toBe('high')
  })

  test('clamps the raw pick into the model-supported effort set', () => {
    const tab = makeTab([userMessage('x')], 'plan')
    const restricted: ModelInfo = { ...baseModel, supportedReasoningEfforts: ['high', 'medium'] }
    const effort = resolveReasoningEffort(tab, restricted)
    expect(['high', 'medium']).toContain(effort)
    expect(effort).not.toBe('low')
  })
})
