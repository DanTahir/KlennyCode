import { describe, expect, test, beforeEach } from 'bun:test'
import {
  breakpointIndices,
  fingerprintBreakpoints,
  fingerprintTools,
  formatFingerprints,
  formatToolsFingerprint,
  nextRequestId,
  noteToolsFingerprint,
  resetRequestIds,
  resetToolsFingerprints
} from '../src/main/openrouter/cacheDiag'
import { applyCacheControl } from '../src/main/openrouter/caching'
import type { ChatMessage, ContentPart } from '../src/main/openrouter/client'

const mark = (text: string): ContentPart[] => [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
const parts = (text: string): ContentPart[] => [{ type: 'text', text }]

describe('breakpointIndices', () => {
  test('finds every marked message in ascending order, ignoring string-content messages', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: mark('sys') },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: mark('hi') },
      { role: 'user', content: parts('unmarked parts') }
    ]
    expect(breakpointIndices(msgs)).toEqual([0, 2])
  })

  // A breakpoint on an assistant turn now normally rides its last tool_call rather than a
  // content part (see `tryMark`). A checker that only looked at content would report
  // `breakpointsAt=[0]` for a perfectly healthy request — i.e. it would recreate the exact false
  // alarm this diagnostic exists to rule out.
  test('finds a marker carried on a tool call, not just on a content part', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: mark('sys') },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' }, cache_control: { type: 'ephemeral' } }
        ]
      },
      { role: 'tool', content: 'result', tool_call_id: 'a' }
    ]
    expect(breakpointIndices(msgs)).toEqual([0, 2])
    // And the log says WHERE it landed, so a silent regression back to part-marking is visible.
    expect(fingerprintBreakpoints(msgs, [0, 2]).map((f) => f.markedOn)).toEqual(['part', 'call'])
  })

  test('the noMark fingerprint ignores a tool-call marker, so only the marker moving is invisible', () => {
    const base: ChatMessage = {
      role: 'assistant',
      content: 'text',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
    }
    const markedCall: ChatMessage = {
      ...base,
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' }, cache_control: { type: 'ephemeral' } }]
    }
    const unmarked = fingerprintBreakpoints([base], [0])[0]
    const marked = fingerprintBreakpoints([markedCall], [0])[0]
    // Same conversation, marker added: the wire hash must change and noMark/text must not —
    // that's the "only the marker itself moved" row of the interpretation table.
    expect(marked.wire).not.toBe(unmarked.wire)
    expect(marked.noMark).toBe(unmarked.noMark)
    expect(marked.text).toBe(unmarked.text)
  })
})

// The `tools` array is the one part of the cacheable prefix the message fingerprints above cannot
// see, since a provider hashes tool definitions ahead of the system prompt. These tests pin that
// the diagnostic can tell the two causes apart (a tool appearing vs. a description edited) — that
// distinction is what makes the `tools=` field actionable instead of just another hash.
describe('fingerprintTools', () => {
  const tool = (name: string, description = 'does a thing') => ({
    type: 'function' as const,
    function: { name, description, parameters: { type: 'object', properties: {} } }
  })

  beforeEach(resetToolsFingerprints)

  test('an unchanged array fingerprints identically; absent/empty is explicitly n=0', () => {
    expect(fingerprintTools([tool('read_file'), tool('write_file')])).toEqual(
      fingerprintTools([tool('read_file'), tool('write_file')])
    )
    expect(fingerprintTools(undefined).count).toBe(0)
    expect(fingerprintTools([]).count).toBe(0)
    expect(formatToolsFingerprint(fingerprintTools(undefined))).toMatch(/^n=0 /)
  })

  test('a tool appearing mid-conversation moves count, names AND defs — the bug this exists for', () => {
    const before = fingerprintTools([tool('create_checklist')])
    const after = fingerprintTools([tool('create_checklist'), tool('update_checklist')])
    expect(after.count).toBe(before.count + 1)
    expect(after.names).not.toBe(before.names)
    expect(after.defs).not.toBe(before.defs)
  })

  test('an edited description moves defs but NOT names — a new build, not a gating flip', () => {
    const v1 = fingerprintTools([tool('browser', 'old description')])
    const v2 = fingerprintTools([tool('browser', 'new description')])
    expect(v2.names).toBe(v1.names)
    expect(v2.defs).not.toBe(v1.defs)
  })

  test('reordering is a real difference — the provider hashes bytes, not a set', () => {
    const asc = fingerprintTools([tool('a'), tool('b')])
    const desc = fingerprintTools([tool('b'), tool('a')])
    expect(desc.count).toBe(asc.count)
    expect(desc.names).not.toBe(asc.names)
    expect(desc.defs).not.toBe(asc.defs)
  })

  test('noteToolsFingerprint stays silent on a first request and reports only a later change', () => {
    const fp = fingerprintTools([tool('read_file')])
    expect(noteToolsFingerprint('tab-1:opus', fp)).toBe(false)
    expect(noteToolsFingerprint('tab-1:opus', fp)).toBe(false)
    const grown = fingerprintTools([tool('read_file'), tool('update_checklist')])
    expect(noteToolsFingerprint('tab-1:opus', grown)).toBe(true)
    // Reported once, not every request thereafter — the new shape is now the baseline.
    expect(noteToolsFingerprint('tab-1:opus', grown)).toBe(false)
  })

  test('tracking is per conversation, so one tab changing never warns on another', () => {
    const one = fingerprintTools([tool('read_file')])
    const two = fingerprintTools([tool('read_file'), tool('grep')])
    expect(noteToolsFingerprint('tab-1:opus', one)).toBe(false)
    expect(noteToolsFingerprint('tab-2:opus', two)).toBe(false)
    expect(noteToolsFingerprint('tab-2:opus', two)).toBe(false)
    expect(noteToolsFingerprint('tab-1:opus', one)).toBe(false)
  })

  test('the rendered field is one greppable trio of tokens', () => {
    expect(formatToolsFingerprint(fingerprintTools([tool('x')]))).toMatch(/^n=1 names=[0-9a-f]{8} defs=[0-9a-f]{8}$/)
  })
})

describe('fingerprintBreakpoints', () => {
  test('covers the whole prefix through each index, in ascending order', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: mark('sys') },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: mark('hi') }
    ]
    const fps = fingerprintBreakpoints(msgs, [2, 0])
    expect(fps.map((f) => f.idx)).toEqual([0, 2])
    expect(fps.map((f) => f.role)).toEqual(['system', 'assistant'])
    // A longer prefix must serialize to strictly more characters than a shorter one.
    expect(fps[1].chars).toBeGreaterThan(fps[0].chars)
  })

  test('reports the marked message\'s own wire shape', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: mark('hello') }
    ]
    const fps = fingerprintBreakpoints(msgs, [0, 1])
    expect(fps[0].shape).toBe('str')
    expect(fps[1].shape).toBe('parts')
  })

  test('out-of-range and duplicate indices are skipped, never thrown on', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'sys' }]
    expect(fingerprintBreakpoints(msgs, [0, 0, 5, -1]).map((f) => f.idx)).toEqual([0])
    expect(fingerprintBreakpoints([], [0])).toEqual([])
  })

  test('appending later messages never changes an earlier prefix fingerprint', () => {
    const base: ChatMessage[] = [
      { role: 'system', content: mark('sys') },
      { role: 'user', content: 'hello' }
    ]
    const grown: ChatMessage[] = [...base, { role: 'assistant', content: 'hi' }, { role: 'user', content: 'more' }]
    expect(fingerprintBreakpoints(grown, [0])[0]).toEqual(fingerprintBreakpoints(base, [0])[0])
  })

  // The three hashes exist to localize a divergence. Each of the next three tests pins exactly one
  // row of the table in cacheDiag.ts's doc comment, so the discriminator can't silently collapse
  // into "three copies of the same hash".
  test('row 1 — changed content upstream of the breakpoint moves all three hashes', () => {
    const a: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: mark('hello') }]
    const b: ChatMessage[] = [{ role: 'system', content: 'sys CHANGED' }, { role: 'user', content: mark('hello') }]
    const [fa] = fingerprintBreakpoints(a, [1])
    const [fb] = fingerprintBreakpoints(b, [1])
    expect(fa.text).not.toBe(fb.text)
    expect(fa.noMark).not.toBe(fb.noMark)
    expect(fa.wire).not.toBe(fb.wire)
  })

  test('row 2 — a string<->parts shape flip moves wire and noMark but NOT text', () => {
    const asString: ChatMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: mark('hello') }]
    const asParts: ChatMessage[] = [{ role: 'system', content: parts('sys') }, { role: 'user', content: mark('hello') }]
    const [fs] = fingerprintBreakpoints(asString, [1])
    const [fp] = fingerprintBreakpoints(asParts, [1])
    expect(fs.text).toBe(fp.text)
    expect(fs.noMark).not.toBe(fp.noMark)
    expect(fs.wire).not.toBe(fp.wire)
  })

  test('row 3 — only the marker moving leaves text and noMark identical', () => {
    const markedEarly: ChatMessage[] = [{ role: 'system', content: mark('sys') }, { role: 'user', content: parts('hello') }]
    const markedLate: ChatMessage[] = [{ role: 'system', content: parts('sys') }, { role: 'user', content: mark('hello') }]
    const [fe] = fingerprintBreakpoints(markedEarly, [1])
    const [fl] = fingerprintBreakpoints(markedLate, [1])
    expect(fe.text).toBe(fl.text)
    expect(fe.noMark).toBe(fl.noMark)
    expect(fe.wire).not.toBe(fl.wire)
  })

  test('image payloads are reduced to a length tag rather than hashed wholesale', () => {
    const big = `data:image/png;base64,${'A'.repeat(5000)}`
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: big } }, { type: 'text', text: 'look', cache_control: { type: 'ephemeral' } }] }
    ]
    // Should not throw, and should still produce a stable fingerprint for the prefix.
    const [fp] = fingerprintBreakpoints(msgs, [1])
    expect(fp.text.length).toBe(8)
    expect(fp.chars).toBeGreaterThan(5000)
  })
})

// The measurement this module exists for, expressed against the real applyCacheControl. Since the
// interior-marker fix (see caching.ts's doc comment for the measured `[cache]` ladder), the only
// message whose wire shape ever changes across requests is the previous request's advancing
// breakpoint — and it changes exactly AT the boundary of the block it wrote, a difference live
// evidence proved the provider normalizes away (r3 read prefix@40 back exactly, 133399 tokens,
// while index 40 was an unmarked bare string). Nothing INTERIOR to a cached prefix ever changes,
// which is the property that keeps blocks matchable.
describe('shape stability of a cached prefix across consecutive requests (live behaviour)', () => {
  // Simulates the growth pattern of a real turn: each step appends an assistant + tool message,
  // and the trailing note always reserves the true last slot.
  const step = (n: number): ChatMessage[] => {
    const msgs: ChatMessage[] = [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'do the thing' }]
    for (let i = 0; i < n; i++) {
      msgs.push({ role: 'assistant', content: `calling tool ${i}` })
      msgs.push({ role: 'tool', content: `tool result ${i}`, tool_call_id: `call_${i}` } as ChatMessage)
    }
    return msgs
  }

  test('everything interior to a written block is byte-identical on the next request', () => {
    const a = applyCacheControl(step(2), true, true, 'note A')
    const bpIdx = a.length - 2
    expect(bpIdx).toBe(4)
    const b = applyCacheControl(step(3), true, true, 'note B')

    // The prefix strictly inside the block A wrote is untouched on all three hashes — no interior
    // marker churn, which is exactly what used to break the match.
    const [fa] = fingerprintBreakpoints(a, [bpIdx - 1])
    const [fb] = fingerprintBreakpoints(b, [bpIdx - 1])
    expect(fa.wire).toBe(fb.wire)
    expect(fa.noMark).toBe(fb.noMark)
    expect(fa.text).toBe(fb.text)
  })

  test('only the boundary message itself loses its marker — the difference shown to be benign', () => {
    const a = applyCacheControl(step(2), true, true, 'note A')
    const bpIdx = a.length - 2
    const b = applyCacheControl(step(3), true, true, 'note B')

    expect(Array.isArray(a[bpIdx].content)).toBe(true)
    expect(typeof b[bpIdx].content).toBe('string')

    const [fa] = fingerprintBreakpoints(a, [bpIdx])
    const [fb] = fingerprintBreakpoints(b, [bpIdx])
    expect(fa.text).toBe(fb.text)
    expect(fa.noMark).not.toBe(fb.noMark)
    expect(fa.shape).toBe('parts')
    expect(fb.shape).toBe('str')
  })
})

describe('formatFingerprints', () => {
  test('renders one compact segment per breakpoint', () => {
    const msgs: ChatMessage[] = [{ role: 'system', content: mark('sys') }, { role: 'user', content: mark('hello') }]
    const line = formatFingerprints(fingerprintBreakpoints(msgs, [0, 1]))
    expect(line).toContain('#0:system:parts')
    expect(line).toContain('#1:user:parts')
    expect(line.split(' | ').length).toBe(2)
  })

  test('says "none" rather than emitting an empty field', () => {
    expect(formatFingerprints([])).toBe('none')
  })
})

describe('nextRequestId', () => {
  beforeEach(() => resetRequestIds())

  test('is monotonic and unique, so overlapping requests stay correlatable', () => {
    expect([nextRequestId(), nextRequestId(), nextRequestId()]).toEqual(['r1', 'r2', 'r3'])
  })
})
