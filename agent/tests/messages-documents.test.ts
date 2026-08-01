import { describe, expect, test } from 'bun:test'
import { toORMessages } from '../src/main/agent/messages'
import type { ChatMessage } from '@shared/types'

function userMsgWithDoc(id: string, text: string, doc: { filename: string; mimeType: string; extractedText: string; truncated?: boolean }): ChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text }, { type: 'document', ...doc }],
    createdAt: Date.now()
  }
}

describe('toORMessages — user-attached documents', () => {
  test('a user message with a document produces an array content with a wrapped text part', () => {
    const messages: ChatMessage[] = [
      userMsgWithDoc('u0', 'Please review this', {
        filename: 'notes.md',
        mimeType: 'text/markdown',
        extractedText: '# Notes\n\nSome content here.'
      })
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const userMsg = or.find((m) => m.role === 'user')
    expect(userMsg).toBeDefined()
    expect(Array.isArray(userMsg!.content)).toBe(true)
    const parts = userMsg!.content as Array<{ type: string; text?: string }>
    expect(parts[0]).toEqual({ type: 'text', text: 'Please review this' })
    const docPart = parts.find((p) => p.text?.includes('notes.md'))
    expect(docPart).toBeDefined()
    expect(docPart!.text).toContain('# Notes')
    expect(docPart!.text).toContain('Some content here.')
    expect(docPart!.text).toContain('Attached document: notes.md')
    expect(docPart!.text).toContain('End of notes.md')
  })

  test('a truncated document is flagged in the wrapped text', () => {
    const messages: ChatMessage[] = [
      userMsgWithDoc('u0', 'file', {
        filename: 'big.txt',
        mimeType: 'text/plain',
        extractedText: 'x'.repeat(100),
        truncated: true
      })
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const userMsg = or.find((m) => m.role === 'user')
    const parts = userMsg!.content as Array<{ type: string; text?: string }>
    const docPart = parts.find((p) => p.text?.includes('big.txt'))
    expect(docPart!.text).toContain('(truncated)')
  })

  test('a document-only message (no text block) still builds array content', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u0',
        role: 'user',
        blocks: [{ type: 'document', filename: 'file.txt', mimeType: 'text/plain', extractedText: 'hello' }],
        createdAt: Date.now()
      }
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const userMsg = or.find((m) => m.role === 'user')
    expect(Array.isArray(userMsg!.content)).toBe(true)
    const parts = userMsg!.content as Array<{ type: string; text?: string }>
    expect(parts.some((p) => p.text?.includes('file.txt'))).toBe(true)
  })

  test('documents and images can coexist in the same message, both as array content parts', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u0',
        role: 'user',
        blocks: [
          { type: 'text', text: 'look at both' },
          { type: 'document', filename: 'a.md', mimeType: 'text/markdown', extractedText: 'doc content' },
          { type: 'image', dataUrl: 'data:image/png;base64,aGVsbG8=' }
        ],
        createdAt: Date.now()
      }
    ]
    const or = toORMessages(messages, 'SYSTEM')
    const userMsg = or.find((m) => m.role === 'user')
    const parts = userMsg!.content as Array<{ type: string }>
    expect(parts.some((p) => p.type === 'text')).toBe(true)
    expect(parts.some((p) => p.type === 'image_url')).toBe(true)
    // document is folded into a text part alongside the real text part, so there are 2 text parts + 1 image_url
    expect(parts.filter((p) => p.type === 'text').length).toBe(2)
  })

  test('a message with only plain text (no attachments) still collapses to a plain string, unaffected by document handling', () => {
    const messages: ChatMessage[] = [{ id: 'u0', role: 'user', blocks: [{ type: 'text', text: 'just text' }], createdAt: Date.now() }]
    const or = toORMessages(messages, 'SYSTEM')
    const userMsg = or.find((m) => m.role === 'user')
    expect(typeof userMsg!.content).toBe('string')
  })
})
