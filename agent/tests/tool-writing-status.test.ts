import { describe, test, expect } from 'bun:test'
import {
  dropWritingPlaceholders,
  formatArgSize,
  shouldEmitWriting,
  sniffWritingTarget,
  WRITING_EMIT_INTERVAL_MS,
  MAX_WRITING_LABEL_CHARS
} from '@shared/toolWriting'
import type { ChatMessage } from '@shared/types'

function msg(blocks: ChatMessage['blocks']): ChatMessage {
  return { id: 'm1', role: 'assistant', blocks, createdAt: 0 }
}

describe('formatArgSize', () => {
  test('bytes, kilobytes and megabytes', () => {
    expect(formatArgSize(0)).toBe('0 B')
    expect(formatArgSize(512)).toBe('512 B')
    expect(formatArgSize(2048)).toBe('2.0 KB')
    expect(formatArgSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  test('never renders a negative or non-finite size', () => {
    expect(formatArgSize(-5)).toBe('0 B')
    expect(formatArgSize(Number.NaN)).toBe('0 B')
  })
})

describe('shouldEmitWriting', () => {
  test('always emits the first update for a call, however small', () => {
    // The card must appear the moment writing starts; a short call may never get a second chance.
    expect(shouldEmitWriting({ now: 1000, lastEmitAt: 0, charsSoFar: 0, lastEmitChars: -1 })).toBe(true)
  })

  test('throttles within the interval and emits after it', () => {
    const base = { lastEmitAt: 1000, lastEmitChars: 100 }
    expect(shouldEmitWriting({ ...base, now: 1000 + WRITING_EMIT_INTERVAL_MS - 1, charsSoFar: 5000 })).toBe(false)
    expect(shouldEmitWriting({ ...base, now: 1000 + WRITING_EMIT_INTERVAL_MS, charsSoFar: 5000 })).toBe(true)
  })

  test('never re-emits an unchanged size', () => {
    expect(
      shouldEmitWriting({ now: 999_999, lastEmitAt: 1000, charsSoFar: 100, lastEmitChars: 100 })
    ).toBe(false)
  })
})

describe('dropWritingPlaceholders', () => {
  test('removes stranded writing placeholders but keeps real tool calls', () => {
    const messages = [
      msg([
        { type: 'text', text: 'hello' },
        { type: 'tool_call', id: 't1', toolName: 'read_file', args: { path: 'a.ts' }, status: 'success' },
        { type: 'tool_call', id: 't2', toolName: 'write_file', args: {}, status: 'writing', writingChars: 900 }
      ])
    ]
    const pruned = dropWritingPlaceholders(messages)
    expect(pruned[0].blocks.map((b) => (b.type === 'tool_call' ? b.id : b.type))).toEqual(['text', 't1'])
  })

  test('returns the SAME array when there is nothing to prune (no needless re-render)', () => {
    const messages = [
      msg([{ type: 'tool_call', id: 't1', toolName: 'read_file', args: {}, status: 'running' }])
    ]
    expect(dropWritingPlaceholders(messages)).toBe(messages)
  })
})

describe('sniffWritingTarget', () => {
  test('picks the path out of a complete write_file payload', () => {
    const raw = JSON.stringify({ path: 'agent/src/foo.ts', content: 'import x from "y"' })
    expect(sniffWritingTarget('write_file', raw)).toBe('agent/src/foo.ts')
  })

  test('works on a path that is still mid-stream (unterminated JSON string)', () => {
    expect(sniffWritingTarget('write_file', '{"path":"agent/src/fo')).toBe('agent/src/fo')
  })

  test('returns undefined before anything identifying has arrived', () => {
    expect(sniffWritingTarget('write_file', '')).toBeUndefined()
    expect(sniffWritingTarget('write_file', '{"pa')).toBeUndefined()
  })

  test('a "path" inside file CONTENT never masquerades as the target', () => {
    // Regression guard: this agent constantly writes code/prose that mentions paths, and the
    // content value arrives in the same partial JSON as the real target.
    const raw = JSON.stringify({ path: 'real.ts', content: '{"path":"fake.ts"}' })
    expect(sniffWritingTarget('write_file', raw)).toBe('real.ts')
  })

  test('batch tools report progress through the list, newest file last', () => {
    const raw = '{"files":[{"path":"a.ts","content":"aaa"},{"path":"b.ts","content":"bb'
    expect(sniffWritingTarget('multi_write', raw)).toBe('2 files · b.ts')
  })

  test('a single-entry batch reads as one file, not "1 files"', () => {
    expect(sniffWritingTarget('multi_write', '{"files":[{"path":"only.ts","content":"x')).toBe('only.ts')
  })

  test('batch file count is not inflated by paths quoted inside content', () => {
    const raw = JSON.stringify({
      files: [{ path: 'a.ts', content: 'see {"path":"ghost.ts"} and {"path":"ghost2.ts"}' }]
    })
    expect(sniffWritingTarget('multi_write', raw)).toBe('a.ts')
  })

  test('per-tool preference beats the generic key order', () => {
    // grep is identified by its pattern, not by the directory it happens to search.
    const raw = JSON.stringify({ pattern: 'TODO', path: 'agent/src' })
    expect(sniffWritingTarget('grep', raw)).toBe('TODO')
    expect(sniffWritingTarget('run_command', JSON.stringify({ command: 'bun test' }))).toBe('bun test')
    expect(
      sniffWritingTarget('browser', JSON.stringify({ action: 'navigate', url: 'https://example.com' }))
    ).toBe('https://example.com')
  })

  test('escapes and newlines are flattened into a single readable line', () => {
    const raw = JSON.stringify({ command: 'echo "hi"\n  && ls' })
    expect(sniffWritingTarget('run_command', raw)).toBe('echo "hi" && ls')
  })

  test('an over-long label is elided rather than allowed to stretch the card', () => {
    const long = 'a'.repeat(300)
    const label = sniffWritingTarget('write_file', JSON.stringify({ path: long }))!
    expect(label.length).toBe(MAX_WRITING_LABEL_CHARS)
    expect(label.endsWith('…')).toBe(true)
  })
})
