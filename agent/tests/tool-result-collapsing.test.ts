import { describe, expect, test } from 'bun:test'
import type { ChatMessage, ToolCallBlock, ToolResultPayload } from '@shared/types'
import { resourceKey, findNewlySupersededBlocks } from '../src/main/agent/collapsing'
import { toORMessages } from '../src/main/agent/messages'

function assistantToolMessage(id: string, toolName: string, args: Record<string, unknown>, result: ToolResultPayload): ChatMessage {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id,
    toolName,
    args,
    status: result.ok ? 'success' : 'error',
    result
  }
  return { id: `msg_${id}`, role: 'assistant', blocks: [block], createdAt: 0 }
}

describe('resourceKey', () => {
  test('file-based tools key on path', () => {
    expect(resourceKey('read_file', { path: 'a.ts' })).toBe(resourceKey('edit_file', { path: 'a.ts' }))
    expect(resourceKey('read_file', { path: 'a.ts' })).not.toBe(resourceKey('read_file', { path: 'b.ts' }))
  })

  test('grep includes case_insensitive in the key', () => {
    const a = resourceKey('grep', { pattern: 'foo', path: '.', case_insensitive: false })
    const b = resourceKey('grep', { pattern: 'foo', path: '.', case_insensitive: true })
    expect(a).not.toBe(b)
  })

  test('fetch_url keys on url', () => {
    expect(resourceKey('fetch_url', { url: 'https://a.com' })).toBe(resourceKey('fetch_url', { url: 'https://a.com' }))
    expect(resourceKey('fetch_url', { url: 'https://a.com' })).not.toBe(resourceKey('fetch_url', { url: 'https://b.com' }))
  })

  test('run_command is never collapsible', () => {
    expect(resourceKey('run_command', { command: 'npm test' })).toBeNull()
  })
})

describe('findNewlySupersededBlocks', () => {
  test('two read_file calls on the same path: first is superseded, second is not', () => {
    const messages = [
      assistantToolMessage('call1', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' }),
      assistantToolMessage('call2', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' })
    ]
    const superseded = findNewlySupersededBlocks(messages)
    expect(superseded.map((s) => s.toolCallId)).toEqual(['call1'])
  })

  test('read then edit then read again: only the last call is not superseded', () => {
    const messages = [
      assistantToolMessage('call1', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' }),
      assistantToolMessage('call2', 'edit_file', { path: 'a.ts', old_string: 'x', new_string: 'y' }, { ok: true, summary: 'ok' }),
      assistantToolMessage('call3', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' })
    ]
    const superseded = findNewlySupersededBlocks(messages)
    expect(superseded.map((s) => s.toolCallId).sort()).toEqual(['call1', 'call2'])
  })

  test('original result field is never touched by supersession detection', () => {
    const original: ToolResultPayload = { ok: true, summary: 'ok', data: { content: 'full file contents here' } }
    const messages = [
      assistantToolMessage('call1', 'read_file', { path: 'a.ts' }, original),
      assistantToolMessage('call2', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' })
    ]
    findNewlySupersededBlocks(messages)
    const block = messages[0].blocks[0] as ToolCallBlock
    expect(block.result).toEqual(original)
    expect(block.result).toBe(original)
  })

  test('failed result is never marked superseded even if a later call shares its resource key', () => {
    const messages = [
      assistantToolMessage('call1', 'edit_file', { path: 'a.ts', old_string: 'x', new_string: 'y' }, { ok: false, summary: 'not found', error: 'not_found' }),
      assistantToolMessage('call2', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' })
    ]
    const superseded = findNewlySupersededBlocks(messages)
    expect(superseded).toEqual([])
  })

  test('different paths never collapse each other', () => {
    const messages = [
      assistantToolMessage('call1', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' }),
      assistantToolMessage('call2', 'read_file', { path: 'b.ts' }, { ok: true, summary: 'ok' })
    ]
    expect(findNewlySupersededBlocks(messages)).toEqual([])
  })

  test('grep with different case_insensitive values on same pattern/path is not collapsed', () => {
    const messages = [
      assistantToolMessage('call1', 'grep', { pattern: 'foo', path: '.', case_insensitive: false }, { ok: true, summary: 'ok' }),
      assistantToolMessage('call2', 'grep', { pattern: 'foo', path: '.', case_insensitive: true }, { ok: true, summary: 'ok' })
    ]
    expect(findNewlySupersededBlocks(messages)).toEqual([])
  })

  test('run_command never collapses even with an identical command string repeated', () => {
    const messages = [
      assistantToolMessage('call1', 'run_command', { command: 'npm test' }, { ok: true, summary: 'ok' }),
      assistantToolMessage('call2', 'run_command', { command: 'npm test' }, { ok: true, summary: 'ok' })
    ]
    expect(findNewlySupersededBlocks(messages)).toEqual([])
  })

  test('already-superseded blocks are not re-annotated (idempotent)', () => {
    const first = assistantToolMessage('call1', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' })
    ;(first.blocks[0] as ToolCallBlock).supersededSummary = 'already stubbed'
    const messages = [first, assistantToolMessage('call2', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' })]
    expect(findNewlySupersededBlocks(messages)).toEqual([])
  })

  test('only assistant-role blocks are considered (tool-role duplicate copies with empty args are ignored)', () => {
    const assistantMsg = assistantToolMessage('call1', 'read_file', { path: 'a.ts' }, { ok: true, summary: 'ok' })
    // Simulates the paired tool-role message with args: {} that orchestrator.ts also creates.
    const toolRoleBlock: ToolCallBlock = {
      type: 'tool_call',
      id: 'call1',
      toolName: 'read_file',
      args: {},
      status: 'success',
      result: { ok: true, summary: 'ok' }
    }
    const toolRoleMsg: ChatMessage = { id: 'toolmsg1', role: 'tool', blocks: [toolRoleBlock], createdAt: 0 }
    const secondAssistant = assistantToolMessage('call2', 'read_file', { path: 'b.ts' }, { ok: true, summary: 'ok' })
    // If the tool-role empty-args copy were mistakenly considered, its bogus key ("file:")
    // would collide with any other empty-path call and misfire; here it must simply be a no-op.
    const superseded = findNewlySupersededBlocks([assistantMsg, toolRoleMsg, secondAssistant])
    expect(superseded).toEqual([])
  })
})

function toolRoleMessage(id: string, toolName: string, result: ToolResultPayload, supersededSummary?: string): ChatMessage {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id,
    toolName,
    args: {},
    status: result.ok ? 'success' : 'error',
    result,
    supersededSummary
  }
  return { id: `toolmsg_${id}`, role: 'tool', blocks: [block], createdAt: 0 }
}

describe('toORMessages', () => {
  test('a block with supersededSummary sends the stub instead of the full result (collapsing enabled)', () => {
    const messages = [toolRoleMessage('call1', 'read_file', { ok: true, summary: 'ok', data: { content: 'huge file body' } }, 'stub text')]
    const out = toORMessages(messages, 'sys', true)
    const toolMsg = out.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toBe('stub text')
  })

  test('a block without supersededSummary sends the full compacted result', () => {
    const messages = [toolRoleMessage('call1', 'read_file', { ok: true, summary: 'ok', data: { content: 'full body' } })]
    const out = toORMessages(messages, 'sys', true)
    const toolMsg = out.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('full body')
  })

  test('setting disabled: always sends full content even when supersededSummary is present', () => {
    const messages = [toolRoleMessage('call1', 'read_file', { ok: true, summary: 'ok', data: { content: 'full body' } }, 'stub text')]
    const out = toORMessages(messages, 'sys', false)
    const toolMsg = out.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('full body')
    expect(toolMsg?.content).not.toBe('stub text')
  })
})
