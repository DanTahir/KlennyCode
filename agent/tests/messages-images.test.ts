import { describe, expect, test } from 'bun:test'
import { toORMessages } from '../src/main/agent/messages'
import type { ChatMessage } from '@shared/types'

const PNG_DATA_URL = 'data:image/png;base64,aGVsbG8='

function userTextMsg(id: string, text: string): ChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }], createdAt: Date.now() }
}

function assistantToolCallMsg(id: string, calls: Array<{ toolCallId: string; toolName: string }>): ChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: calls.map((c) => ({ type: 'tool_call', id: c.toolCallId, toolName: c.toolName, args: { path: 'x.png' }, status: 'success' })),
    createdAt: Date.now()
  }
}

function toolResultMsg(id: string, toolCallId: string, toolName: string, imageDataUrl?: string): ChatMessage {
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
        result: { ok: true, summary: 'Read image x.png (10 KB)', data: { path: 'x.png', mimeType: 'image/png' } }
      },
      ...(imageDataUrl ? [{ type: 'image' as const, dataUrl: imageDataUrl }] : [])
    ],
    createdAt: Date.now()
  }
}

describe('toORMessages — tool-result images (read_image)', () => {
  test('a tool result carrying an ImageBlock is followed by a synthetic user message with an image_url part', () => {
    const messages: ChatMessage[] = [
      userTextMsg('u0', 'look at this screenshot'),
      assistantToolCallMsg('a0', [{ toolCallId: 'tc1', toolName: 'read_image' }]),
      toolResultMsg('t0', 'tc1', 'read_image', PNG_DATA_URL)
    ]
    const or = toORMessages(messages, 'SYSTEM')

    const toolMsgIdx = or.findIndex((m) => m.role === 'tool')
    expect(toolMsgIdx).toBeGreaterThan(-1)
    // Tool result content stays plain text/JSON — no image_url leaked into the tool message itself.
    expect(typeof or[toolMsgIdx].content).toBe('string')
    expect(String(or[toolMsgIdx].content)).not.toContain('base64')

    const trailing = or[toolMsgIdx + 1]
    expect(trailing).toBeDefined()
    expect(trailing.role).toBe('user')
    expect(Array.isArray(trailing.content)).toBe(true)
    const parts = trailing.content as Array<{ type: string; image_url?: { url: string } }>
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('image_url')
    expect(parts[0].image_url?.url).toBe(PNG_DATA_URL)
  })

  test('a tool result with no image produces no trailing synthetic user message', () => {
    const messages: ChatMessage[] = [
      userTextMsg('u0', 'read this file'),
      assistantToolCallMsg('a0', [{ toolCallId: 'tc1', toolName: 'read_file' }]),
      toolResultMsg('t0', 'tc1', 'read_file')
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const toolMsgIdx = or.findIndex((m) => m.role === 'tool')
    expect(or[toolMsgIdx + 1]).toBeUndefined()
  })

  test('images from multiple parallel tool calls in the same batch are batched into one trailing user message, never interleaved', () => {
    const messages: ChatMessage[] = [
      userTextMsg('u0', 'look at both screenshots'),
      assistantToolCallMsg('a0', [
        { toolCallId: 'tc1', toolName: 'read_image' },
        { toolCallId: 'tc2', toolName: 'read_image' }
      ]),
      toolResultMsg('t0', 'tc1', 'read_image', PNG_DATA_URL),
      toolResultMsg('t1', 'tc2', 'read_image', PNG_DATA_URL)
    ]
    const or = toORMessages(messages, 'SYSTEM')

    const toolMsgs = or.filter((m) => m.role === 'tool')
    expect(toolMsgs).toHaveLength(2)
    // No 'user' message should sit between the two tool messages.
    const firstToolIdx = or.findIndex((m) => m.role === 'tool')
    const secondToolIdx = or.findIndex((m, i) => i > firstToolIdx && m.role === 'tool')
    expect(secondToolIdx).toBe(firstToolIdx + 1)

    // Exactly one trailing user message, carrying both images, right after the second tool message.
    const trailing = or[secondToolIdx + 1]
    expect(trailing.role).toBe('user')
    const parts = trailing.content as Array<{ type: string }>
    expect(parts).toHaveLength(2)
    expect(or[secondToolIdx + 2]).toBeUndefined()
  })

  test('a real user message after tool results still flushes any pending tool images first, in order', () => {
    const messages: ChatMessage[] = [
      userTextMsg('u0', 'look at this'),
      assistantToolCallMsg('a0', [{ toolCallId: 'tc1', toolName: 'read_image' }]),
      toolResultMsg('t0', 'tc1', 'read_image', PNG_DATA_URL),
      userTextMsg('u1', 'thanks, now do something else')
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const toolMsgIdx = or.findIndex((m) => m.role === 'tool')
    expect(or[toolMsgIdx + 1].role).toBe('user') // synthetic image message
    expect(or[toolMsgIdx + 2].role).toBe('user') // the real next user message
    expect(typeof or[toolMsgIdx + 2].content).toBe('string')
  })
})
