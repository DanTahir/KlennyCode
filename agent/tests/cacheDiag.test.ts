import { describe, expect, test, beforeEach } from 'bun:test'
import {
  breakpointIndices,
  fingerprintBreakpoints,
  formatFingerprints,
  nextRequestId,
  resetRequestIds
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

// This is the measurement the whole module exists for, expressed against the real
// applyCacheControl: it documents (does NOT endorse) today's behaviour, where a message marked as
// the advancing breakpoint reverts from content-part-array form back to a bare string two requests
// later, because `priorBreakpointIdx` only ever carries ONE request backwards. If a future change
// stabilizes message shape, the `noMark` assertion here is the one that should be updated — and
// the `text` assertion should keep passing either way.
describe('shape stability of a breakpoint across consecutive requests (live behaviour)', () => {
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

  test('the marked index is re-marked on the next request, then reverts to a bare string on the one after', () => {
    // Request A marks its advancing breakpoint at lastIdx-1 of a 6-message wire payload (idx 4).
    const a = applyCacheControl(step(2), true, true, 'note A')
    const markedIdx = a.length - 2
    expect(markedIdx).toBe(4)
    expect(Array.isArray(a[markedIdx].content)).toBe(true)

    // Request B (one step later) re-marks idx 4 as priorBreakpointIdx, so its shape is preserved.
    const b = applyCacheControl(step(3), true, true, 'note B', markedIdx)
    expect(Array.isArray(b[markedIdx].content)).toBe(true)

    // Request C's prior is now B's own breakpoint, so idx 4 is marked by nobody and reverts to a
    // bare string — the same message, the same meaning, different wire bytes.
    const c = applyCacheControl(step(4), true, true, 'note C', b.length - 2)
    expect(typeof c[markedIdx].content).toBe('string')

    // And that is precisely what the fingerprints localize: identical content, different bytes.
    const [fb] = fingerprintBreakpoints(b, [markedIdx])
    const [fc] = fingerprintBreakpoints(c, [markedIdx])
    expect(fb.text).toBe(fc.text)
    expect(fb.noMark).not.toBe(fc.noMark)
    expect(fb.shape).toBe('parts')
    expect(fc.shape).toBe('str')
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
