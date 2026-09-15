import { describe, expect, test } from 'bun:test'
import {
  sanitizeTabForPersist,
  sanitizeTabsForPersist,
  wasSanitized,
  MAX_PERSISTED_STRING_CHARS,
  MAX_PERSISTED_TAB_CHARS
} from '../src/main/session/sanitize'
import type { ChatMessage, TabSession } from '../shared/types'

// Backstop for the "61 MB session log" incident (see src/main/session/sanitize.ts). One tool
// result holding a 20 MB binary diff made a whole workspace's session file unloadable: the app
// froze on its loading screen and text editors froze opening the log. diff.ts now clamps at the
// source; this module guarantees the invariant structurally, for ANY tool's payload.

function toolCallMessage(id: string, data: Record<string, unknown>): ChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_call',
        id: `call_${id}`,
        toolName: 'delete_file',
        args: { path: 'public/assets/video/clip.mov' },
        status: 'success',
        result: { ok: true, summary: 'Deleted clip.mov', data }
      }
    ],
    createdAt: 1
  }
}

function tabWith(messages: ChatMessage[]): TabSession {
  return {
    id: 'tab1',
    title: 'website_url: dropbox.com',
    mode: 'agent',
    model: 'anthropic/claude-opus-5',
    createdAt: 1,
    updatedAt: 2,
    messages,
    totalCostUsd: 0,
    totalSavingsUsd: 0
  }
}

describe('per-string clamping', () => {
  test('a 20M-char tool-result diff becomes a small persisted payload', () => {
    const giant = 'x'.repeat(20_000_000)
    const { tab, stats } = sanitizeTabForPersist(tabWith([toolCallMessage('m1', { path: 'clip.mov', diff: giant })]))

    // The whole point: a 20M-char payload must not become a 20 MB session file.
    expect(JSON.stringify(tab).length).toBeLessThan(200_000)
    expect(stats.clampedStrings).toBe(1)
    expect(wasSanitized(stats)).toBe(true)

    const block = tab.messages[0].blocks[0]
    if (block.type !== 'tool_call') throw new Error('expected a tool_call block')
    const diff = (block.result?.data as { diff: string }).diff
    expect(diff.length).toBeLessThan(MAX_PERSISTED_STRING_CHARS + 200)
    expect(diff).toContain('truncated for the session log')
    // Sibling fields survive: the transcript must still say what happened.
    expect((block.result?.data as { path: string }).path).toBe('clip.mov')
    expect(block.result?.summary).toBe('Deleted clip.mov')
  })

  test('is PURE — never mutates the live in-memory tab (that feeds toORMessages)', () => {
    const giant = 'x'.repeat(5_000_000)
    const original = tabWith([toolCallMessage('m1', { diff: giant })])
    sanitizeTabForPersist(original)

    const block = original.messages[0].blocks[0]
    if (block.type !== 'tool_call') throw new Error('expected a tool_call block')
    expect((block.result?.data as { diff: string }).diff.length).toBe(5_000_000)
  })

  test('leaves an ordinary tab byte-identical', () => {
    const tab = tabWith([toolCallMessage('m1', { diff: '--- a/f.ts\n+++ b/f.ts\n@@ -1 +1 @@\n-a\n+b' })])
    const { tab: out, stats } = sanitizeTabForPersist(tab)
    expect(JSON.stringify(out)).toBe(JSON.stringify(tab))
    expect(wasSanitized(stats)).toBe(false)
  })

  test('clamps strings nested inside arrays/objects (multi_edit result shape)', () => {
    const tab = tabWith([
      toolCallMessage('m1', { files: [{ path: 'a.ts', diff: 'y'.repeat(300_000) }], paths: ['a.ts'] })
    ])
    const { tab: out, stats } = sanitizeTabForPersist(tab)
    const block = out.messages[0].blocks[0]
    if (block.type !== 'tool_call') throw new Error('expected a tool_call block')
    const files = (block.result?.data as { files: { diff: string }[] }).files
    expect(files[0].diff.length).toBeLessThan(MAX_PERSISTED_STRING_CHARS + 200)
    expect(stats.clampedStrings).toBe(1)
  })

  test('clamps oversized text/thinking blocks and tool-call args', () => {
    const tab = tabWith([
      { id: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'z'.repeat(200_000) }], createdAt: 1 },
      { id: 'm2', role: 'assistant', blocks: [{ type: 'thinking', text: 'z'.repeat(200_000) }], createdAt: 2 },
      {
        id: 'm3',
        role: 'assistant',
        blocks: [
          {
            type: 'tool_call',
            id: 'c3',
            toolName: 'write_file',
            args: { path: 'a.ts', content: 'q'.repeat(200_000) },
            status: 'success'
          }
        ],
        createdAt: 3
      }
    ])
    const { stats } = sanitizeTabForPersist(tab)
    expect(stats.clampedStrings).toBe(3)
  })

  test('image data URLs are deliberately exempt (truncating one only corrupts the thumbnail)', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(300_000)}`
    const tab = tabWith([{ id: 'm1', role: 'assistant', blocks: [{ type: 'image', dataUrl }], createdAt: 1 }])
    const { tab: out, stats } = sanitizeTabForPersist(tab)
    const block = out.messages[0].blocks[0]
    if (block.type !== 'image') throw new Error('expected an image block')
    expect(block.dataUrl).toBe(dataUrl)
    expect(stats.clampedStrings).toBe(0)
  })
})

describe('per-tab size budget', () => {
  test('drops oldest tool-result payloads until the tab fits, keeping the newest intact', () => {
    // 100 individually-legal 60K diffs (~6M chars) — the slow-accumulation version of the same
    // failure: no single string is oversized, but the file still becomes unloadable.
    const messages = Array.from({ length: 100 }, (_, i) => toolCallMessage(`m${i}`, { diff: 'd'.repeat(60_000) }))
    const { tab, stats } = sanitizeTabForPersist(tabWith(messages))

    expect(JSON.stringify(tab).length).toBeLessThanOrEqual(MAX_PERSISTED_TAB_CHARS)
    expect(stats.strippedResults).toBeGreaterThan(0)

    const oldest = tab.messages[0].blocks[0]
    const newest = tab.messages[99].blocks[0]
    if (oldest.type !== 'tool_call' || newest.type !== 'tool_call') throw new Error('expected tool_call blocks')
    expect((oldest.result?.data as { dataOmitted?: boolean }).dataOmitted).toBe(true)
    // ok/summary are always preserved, so the history still reads correctly.
    expect(oldest.result?.summary).toBe('Deleted clip.mov')
    expect(typeof (newest.result?.data as { diff?: string }).diff).toBe('string')
  })
})

describe('sanitizeTabsForPersist', () => {
  test('aggregates stats across tabs and bounds each one', () => {
    const tabs = [
      tabWith([toolCallMessage('m1', { diff: 'x'.repeat(2_000_000) })]),
      tabWith([toolCallMessage('m2', { diff: 'y'.repeat(2_000_000) })])
    ]
    const { tabs: out, stats } = sanitizeTabsForPersist(tabs)
    expect(stats.clampedStrings).toBe(2)
    expect(JSON.stringify(out).length).toBeLessThan(400_000)
  })
})
