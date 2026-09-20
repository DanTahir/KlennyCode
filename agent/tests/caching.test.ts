import { describe, expect, test, beforeEach } from 'bun:test'
import type { ModelInfo } from '@shared/types'
import {
  isExplicitCacheFamily,
  modelSupportsCaching,
  computeCacheSavings,
  applyCacheControl,
  planAdvancingBreakpoint,
  shouldPrimeCache,
  primingLookedIneffective,
  estimatePrefixTokens,
  hashPrefix,
  notePrefixSent,
  prefixLastSentAt,
  markCachePrimingIneffective,
  isCachePrimingIneffective,
  resetCachePrimingState,
  MIN_CACHEABLE_PREFIX_TOKENS,
  PREFIX_CACHE_TTL_MS
} from '../src/main/openrouter/caching'
import type { ChatMessage, ContentPart } from '../src/main/openrouter/client'
import type { ChatMessage as UiMessage } from '@shared/types'
import { toORMessages } from '../src/main/agent/messages'

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

/** Indices of every message carrying a cache_control marker, in ascending order. Checks tool
 *  calls as well as content parts, since both are real breakpoints upstream — deliberately the
 *  same rule as cacheDiag's `hasBreakpoint`, which is what the `[cache]` log reports. */
const markedIndices = (msgs: ChatMessage[]): number[] =>
  msgs
    .map((m, i) =>
      (Array.isArray(m.content) && m.content.some((p) => p.cache_control)) || m.tool_calls?.some((c) => c.cache_control) ? i : -1
    )
    .filter((i) => i >= 0)

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

  test('when trailingNote is given, the breakpoint moves to the second-to-last message and the true last message is left unmarked, note-only', () => {
    const out = applyCacheControl(messages, true, true, 'Current date/time: 12:00:00')

    // The true last message ("How are you?") gets ONLY the trailing note appended — no
    // cache_control marker, so its shape (note or no note) can freely change turn to turn without
    // ever destabilizing a cached breakpoint.
    const last = out[out.length - 1]
    expect(Array.isArray(last.content)).toBe(true)
    const lastParts = last.content as ContentPart[]
    expect(lastParts.length).toBe(2)
    expect(lastParts[0]).toEqual({ type: 'text', text: 'How are you?' })
    expect(lastParts[1]).toEqual({ type: 'text', text: 'Current date/time: 12:00:00' })

    // The message just before it ("Hi there!") gets the actual cache_control breakpoint instead —
    // this message's shape never changes across turns since nothing is ever appended to it.
    const breakpointMsg = out[out.length - 2]
    const bpParts = breakpointMsg.content as ContentPart[]
    expect(bpParts[bpParts.length - 1]).toEqual({ type: 'text', text: 'Hi there!', cache_control: { type: 'ephemeral' } })
  })

  test('trailingNote is still appended even when explicit caching is disabled (implicit-cache models still want it at the tail)', () => {
    const out = applyCacheControl(messages, false, true, 'Current date/time: 12:00:00')
    const last = out[out.length - 1]
    const parts = last.content as ContentPart[]
    expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'Current date/time: 12:00:00' })
    // System message must stay untouched (no cache_control) since caching is disabled.
    expect(out[0].content).toBe(messages[0].content)
  })

  // Regression test for the real "current date/time" bug, part 1 (mid-prefix poisoning): a live,
  // per-request-changing value was being placed BEFORE the growing conversation (either folded
  // into the system prompt, or as a separate early system message ahead of the messages array).
  // Since a cache_control breakpoint's hash covers the entire prefix up to and including it,
  // anything dynamic sitting earlier in that prefix poisons every breakpoint that follows. This
  // test simulates two consecutive turns (same history, new trailing message, only the live note
  // differs) and asserts everything up to and including the breakpoint message stays byte-for-byte
  // identical — only the reserved, never-marked, true-last message differs.
  test('a per-request-changing trailingNote never alters the growing, cacheable conversation prefix across turns', () => {
    const turn2Messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ]

    const outA = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:00:00')
    const outB = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:05:00')

    // Everything through the breakpoint message (second-to-last, since a trailingNote is given)
    // is completely unaffected by the live note.
    expect(outA.slice(0, -1)).toEqual(outB.slice(0, -1))

    // Only the reserved true-last message (note-only, never cache-marked) differs between the
    // two requests.
    const partsA = outA[outA.length - 1].content as ContentPart[]
    const partsB = outB[outB.length - 1].content as ContentPart[]
    expect(partsA[0]).toEqual(partsB[0])
    expect(partsA[1]).not.toEqual(partsB[1])
  })

  // Regression test for the real "current date/time" bug, part 2 (unstable breakpoint shape): even
  // after moving the note to the tail of the last message, that SAME message being both the note
  // carrier AND the cache_control breakpoint meant its shape differed between the turn it was
  // written (marked content + note) and every later turn it was replayed as history (just the
  // content, no note, since only the current turn's last message ever gets one) — silently
  // breaking cache matching for the whole conversation. The fix reserves the true last message
  // exclusively for the note and always marks the message one before it instead, so the marked
  // message's shape never changes across turns regardless of whether a note is present this call.
  test('the breakpoint message is never the same message the trailingNote is appended to, so its shape never changes across turns', () => {
    const turn2Messages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ]
    const out = applyCacheControl(turn2Messages, true, true, 'Current date/time: 12:00:00')

    // "Hi there!" (index 2, second-to-last) carries the breakpoint...
    const breakpointParts = out[2].content as ContentPart[]
    expect(breakpointParts).toEqual([{ type: 'text', text: 'Hi there!', cache_control: { type: 'ephemeral' } }])

    // ...and once this exact message is replayed as history on a later turn (no longer last, no
    // trailingNote appended to it), it is left completely UNMARKED rather than re-marked. That is
    // the property that keeps an already-cached prefix matchable — see the interior-marker
    // regression test below for the measured evidence.
    const laterTurnMessages: ChatMessage[] = [...turn2Messages, { role: 'assistant', content: 'Doing well!' }, { role: 'user', content: 'Great' }]
    const outLater = applyCacheControl(laterTurnMessages, true, true, 'Current date/time: 12:10:00')
    expect(outLater[2].content).toBe('Hi there!')
    expect(breakpointParts[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  // Regression test for the real "newest cache block is never read back" bug, diagnosed from live
  // `[cache]` evidence rather than reasoning. This function used to ALSO re-mark the previous
  // request's breakpoint position, as insurance against implicit cross-request lookback being
  // unreliable. That insurance WAS the bug: a cache_control marker interior to a cached prefix is
  // part of that prefix's identity upstream, and since the re-marked position advances every
  // request, every block was written with an interior marker that had vanished by the time the
  // next request tried to read it.
  //
  // Measured ladder (Opus 5, one conversation, consecutive requests):
  //   r1  cached=0       write=133399   wrote prefix@40 (no interior markers)
  //   r2  cached=133399  write=2094     HIT @40, wrote prefix@44 WITH an interior marker at 40
  //   r3  cached=133399  write=6393     MISS @44 (marker at 40 now gone), fell back to @40
  //   r4  cached=134593  write=6216     MISS @47 (marker at 44 now gone)
  //
  // r3 also proves the insurance was never needed: it read prefix@40 back exactly (133399 tokens)
  // at a position it had not marked, where index 40 was an unmarked bare string.
  test('never marks any message between the system prompt and the advancing breakpoint', () => {
    const longer: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'tool', content: 'tool result 1', tool_call_id: 'a' },
      { role: 'assistant', content: 'Following up' },
      { role: 'user', content: 'Great, one more thing' }
    ]
    // No trailingNote, so the advancing breakpoint sits on the true last message (index 5).
    expect(markedIndices(applyCacheControl(longer, true, true))).toEqual([0, 5])
    // With a trailingNote it sits one earlier (index 4) — still nothing interior.
    expect(markedIndices(applyCacheControl(longer, true, true, 'note'))).toEqual([0, 4])
  })

  // Live `[cache]` ladders showed one perfect correlation across 12 rungs: every exact read-back
  // had an assistant-role boundary, and every miss had a tool-role boundary. A `tool` message is
  // translated into an Anthropic `tool_result` block inside a user turn, so a breakpoint there
  // appears never to produce a matchable entry. The advancing breakpoint therefore walks back off
  // tool messages — see applyCacheControl's doc comment for the measured table.
  test('walks the advancing breakpoint back off a tool message', () => {
    const endsWithToolRun: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Calling tools' },
      { role: 'tool', content: 'result A', tool_call_id: 'a' },
      { role: 'tool', content: 'result B', tool_call_id: 'b' },
      { role: 'user', content: 'note-bearing slot' }
    ]
    // trailingNote reserves index 5, so the raw breakpoint is index 4 — a tool message. It has to
    // walk back past BOTH parallel tool results to the assistant message at index 2.
    expect(markedIndices(applyCacheControl(endsWithToolRun, true, true, 'note'))).toEqual([0, 2])
    // Without a trailingNote the raw breakpoint is index 5, already a user message — left alone.
    expect(markedIndices(applyCacheControl(endsWithToolRun, true, true))).toEqual([0, 5])
  })

  // THE regression this file exists to catch, reproduced from live `[cache]` evidence rather
  // than reasoning. An assistant turn that calls tools without writing any prose first goes out
  // as `content: ''` (deliberate — `thinking` must never be folded into content, see
  // toORMessages), and `''` serializes to ZERO content parts. Since a cache_control marker lives
  // on a part, that message cannot carry one. The tool-skip walk-back lands on exactly that
  // message in a normal agent step, so the marker was silently discarded and the request shipped
  // with only the fixed system breakpoint — re-paying the entire conversation at full price on
  // every step.
  //
  // Counted in process.log across four app sessions: 0 dropped markers in 27 advancing-breakpoint
  // requests before the tool-skip shipped, then 13/85 and 7/16 after it, each one a step where
  // the model went straight to tool calls. Symptom in the log: `cachedTokens` pinned at exactly
  // the system block's size while `promptTokens` climbed past 100k.
  test('still places the advancing breakpoint when the assistant called tools with no prose (content: "")', () => {
    const proseFreeStep: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Working on it' },
      { role: 'tool', content: 'result A', tool_call_id: 'a' },
      // The model went straight to tool calls this step — no preamble, so content is ''.
      { role: 'assistant', content: '', tool_calls: [{ id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: 'result B', tool_call_id: 'b' }
    ]

    // trailingNote reserves index 5, so the raw breakpoint is index 4 — the '' assistant. Its
    // content can't hold a marker, but its tool_call can, so the breakpoint stays right there
    // instead of being dropped (the original bug) or sliding back to index 2.
    expect(markedIndices(applyCacheControl(proseFreeStep, true, true, 'note'))).toEqual([0, 4])

    // Without a trailingNote the raw breakpoint is index 5, a tool message: skip it and land on
    // the same tool-calling assistant at 4.
    expect(markedIndices(applyCacheControl(proseFreeStep, true, true))).toEqual([0, 4])

    const marked = applyCacheControl(proseFreeStep, true, true, 'note')
    expect(marked[4].tool_calls?.[0].cache_control).toEqual({ type: 'ephemeral' })
    // ...and the content stays a bare string: nothing model-visible was synthesized to carry it.
    expect(marked[4].content).toBe('')
  })

  // A breakpoint is a prefix CUT, so it must land after ALL of the turn's tool calls. Marking an
  // earlier call would strand the remaining ones — and their `arguments`, where a big write/edit
  // payload lives — outside the cached prefix. Live-verified on claude-sonnet-5: marking the
  // text part instead of the last call left an 8,483-token tail uncached where marking the last
  // call left 12.
  test('marks the LAST tool call of a parallel batch, not an earlier one', () => {
    const parallel: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
          { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
          { id: 'c', type: 'function', function: { name: 'write_file', arguments: '{"path":"c","content":"big"}' } }
        ]
      },
      { role: 'tool', content: 'result', tool_call_id: 'a' }
    ]
    const calls = applyCacheControl(parallel, true, true, 'note')[2].tool_calls
    expect(calls?.map((c) => Boolean(c.cache_control))).toEqual([false, false, true])
  })

  // The same preference when the model DID write a preamble: the text part is markable, but the
  // tool calls come after it in Anthropic's block order, so the last call still wins.
  test('prefers the last tool call over the text part when the assistant wrote both', () => {
    const both: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant',
        content: 'Let me write that file.',
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'write_file', arguments: '{"path":"a","content":"big"}' } }]
      },
      { role: 'tool', content: 'result', tool_call_id: 'a' }
    ]
    const marked = applyCacheControl(both, true, true, 'note')[2]
    expect(marked.tool_calls?.[0].cache_control).toEqual({ type: 'ephemeral' })
    // The prose is left exactly as it was — still a bare string, still unmarked.
    expect(marked.content).toBe('Let me write that file.')
  })

  // Same hole, reached through a content-parts array rather than a bare string: an assistant
  // message whose parts list is empty is just as unmarkable as one whose content is ''.
  test('skips a message whose content is an empty parts array', () => {
    const emptyParts: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Real text' },
      { role: 'assistant', content: [] },
      { role: 'user', content: 'note-bearing slot' }
    ]
    expect(markedIndices(applyCacheControl(emptyParts, true, true, 'note'))).toEqual([0, 2])
  })

  // The property that actually matters, stated directly: whenever the plan says a breakpoint is
  // placeable, a marker must genuinely appear there. The old code could report a position and
  // then no-op, which is the failure mode that shipped.
  test('a placed breakpoint always produces a real marker, across every tail shape', () => {
    const tails: ChatMessage[][] = [
      [{ role: 'assistant', content: '', tool_calls: [] }, { role: 'tool', content: 'r', tool_call_id: 'a' }],
      [{ role: 'assistant', content: 'prose' }, { role: 'tool', content: 'r', tool_call_id: 'a' }],
      [{ role: 'tool', content: 'r', tool_call_id: 'a' }, { role: 'tool', content: 'r2', tool_call_id: 'b' }],
      [{ role: 'assistant', content: [] }, { role: 'assistant', content: '' }],
      [{ role: 'user', content: 'plain' }]
    ]
    for (const tail of tails) {
      const msgs: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
        ...tail
      ]
      for (const note of [undefined, 'note']) {
        const plan = planAdvancingBreakpoint(msgs, Boolean(note))
        const marked = markedIndices(applyCacheControl(msgs, true, true, note))
        // -1 means "nowhere legal to put it", and then ONLY the system breakpoint may appear.
        expect(marked).toEqual(plan.index < 0 ? [0] : [0, plan.index])
      }
    }
  })

  test('a tool-only history degrades to the system breakpoint rather than marking a tool message', () => {
    const allTools: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'tool', content: 'result A', tool_call_id: 'a' },
      { role: 'tool', content: 'result B', tool_call_id: 'b' }
    ]
    // Walking back lands on the system message itself, where `breakpointIdx > systemIdx` fails —
    // so only the system breakpoint is marked, never a tool message.
    expect(markedIndices(applyCacheControl(allTools, true, true))).toEqual([0])
  })

  // The invariant stated the way it actually matters: as a conversation grows request after
  // request, the marker set INSIDE an already-cached prefix must never change, or the block
  // cached at that prefix stops matching and its tokens get re-written at the write premium.
  test('a prefix that was cached once keeps an identical marker set on every later request', () => {
    const grow = (n: number): ChatMessage[] => {
      const msgs: ChatMessage[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' }
      ]
      for (let i = 0; i < n; i++) {
        msgs.push({ role: 'assistant', content: `step ${i}` })
        msgs.push({ role: 'tool', content: `result ${i}`, tool_call_id: `c${i}` })
      }
      return msgs
    }

    // Request A writes a block ending at its advancing breakpoint...
    const a = applyCacheControl(grow(2), true, true, 'note A')
    const bpIdx = a.length - 2
    expect(markedIndices(a)).toEqual([0, bpIdx])

    // ...and three successively longer later requests all present that same prefix with exactly
    // one marker inside it: the system message, at its fixed position 0.
    for (const n of [3, 4, 5]) {
      const later = applyCacheControl(grow(n), true, true, `note ${n}`)
      expect(markedIndices(later).filter((i) => i <= bpIdx)).toEqual([0])
    }
  })

  // The two invariants the advancing breakpoint must never violate, checked against a realistic
  // prose-free agent turn rather than a hand-picked tail.
  test('the advancing breakpoint is never a tool message and never the note-bearing last message', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' }
    ]
    for (let step = 0; step < 6; step++) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${step}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
      msgs.push({ role: 'tool', content: `result ${step}`, tool_call_id: `c${step}` })
      msgs.push({ role: 'tool', content: `result ${step}b`, tool_call_id: `c${step}b` })

      const marked = markedIndices(applyCacheControl(msgs, true, true, 'note'))
      for (const idx of marked) {
        expect(msgs[idx].role).not.toBe('tool')
        expect(idx).not.toBe(msgs.length - 1)
      }
    }
  })
})

describe('planAdvancingBreakpoint', () => {
  const proseFreeTurn = (steps: number): ChatMessage[] => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Last thing I said out loud' }
    ]
    for (let i = 0; i < steps; i++) {
      msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] })
      msgs.push({ role: 'tool', content: `result ${i}`, tool_call_id: `c${i}` })
    }
    return msgs
  }

  test('reports both causes of the walk-back separately', () => {
    // Assistant messages with neither content nor tool calls are the only truly unmarkable ones
    // left, so this fixture interleaves them with tool results to exercise both counters.
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Prose' },
      { role: 'assistant', content: [] },
      { role: 'tool', content: 'result', tool_call_id: 'a' },
      { role: 'assistant', content: [] },
      { role: 'tool', content: 'result', tool_call_id: 'b' },
      { role: 'user', content: 'note-bearing slot' }
    ]
    const plan = planAdvancingBreakpoint(msgs, true)
    expect(plan.intendedIdx).toBe(6)
    expect(plan.index).toBe(2)
    expect(plan.skippedTool).toBe(2)
    expect(plan.skippedUnmarkable).toBe(2)
  })

  test('a normal step with prose needs no unmarkable skipping at all', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Let me look at that' },
      { role: 'tool', content: 'result', tool_call_id: 'a' }
    ]
    const plan = planAdvancingBreakpoint(msgs, true)
    expect(plan).toEqual({ intendedIdx: 2, index: 2, skippedTool: 0, skippedUnmarkable: 0 })
  })

  // -1 is the ONLY way the advancing breakpoint can go missing now, which is what makes it
  // loggable (streamChatCompletion warns on it) instead of silent.
  test('reports -1, not a bogus index, when nothing legal is left to mark', () => {
    const plan = planAdvancingBreakpoint(
      [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'assistant', content: '', tool_calls: [] },
        { role: 'tool', content: 'result', tool_call_id: 'a' }
      ],
      false
    )
    expect(plan.index).toBe(-1)
    expect(plan.skippedTool).toBe(1)
    expect(plan.skippedUnmarkable).toBe(1)
  })

  // The property the original bug destroyed: the cached prefix must grow with the conversation.
  // A prose-free turn used to pin it at the system block (marker dropped) and, with only the
  // walk-back fix, at the last prose-bearing message. Marking tool calls makes it advance on
  // every single step regardless of whether the model narrates.
  test('the breakpoint advances every step through a prose-free turn', () => {
    let previous = -1
    for (let steps = 1; steps <= 6; steps++) {
      const plan = planAdvancingBreakpoint(proseFreeTurn(steps), true)
      // Always the tool-calling assistant of the newest step, never a slide backwards.
      expect(plan.index).toBe(1 + steps * 2)
      expect(plan.skippedUnmarkable).toBe(0)
      expect(plan.index).toBeGreaterThan(previous)
      previous = plan.index
    }
  })
})

// The hand-written tails above all assume `toORMessages` really does emit `content: ''` for a
// prose-free tool-calling turn. This block removes that assumption by building the wire from a
// real UI history, so the two modules can't drift apart and silently re-open the hole: if
// messages.ts ever stops producing unmarkable assistant messages, these still pass; if caching.ts
// stops tolerating them, they fail.
describe('advancing breakpoint on a wire built by toORMessages', () => {
  const uiTurn = (opts: { preamble: string }): UiMessage[] => [
    { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'do the thing' }], createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      blocks: [
        // Thinking is never folded into content (see toORMessages), so a turn with reasoning but
        // no spoken text still produces content: ''. That combination is the bug's trigger.
        { type: 'thinking', text: 'private reasoning that must not reach content' },
        ...(opts.preamble ? [{ type: 'text' as const, text: opts.preamble }] : []),
        { type: 'tool_call', id: 'c1', toolName: 'read_file', args: { path: 'a.ts' }, status: 'success', result: { ok: true, summary: 'read' } }
      ],
      createdAt: 2
    },
    {
      id: 't1',
      role: 'tool',
      blocks: [{ type: 'tool_call', id: 'c1', toolName: 'read_file', args: { path: 'a.ts' }, status: 'success', result: { ok: true, summary: 'read' } }],
      createdAt: 3
    }
  ]

  test('a prose-free tool-calling turn still gets an advancing breakpoint', () => {
    const wire = toORMessages(uiTurn({ preamble: '' }), 'SYSTEM PROMPT')
    // Precondition: this is the shape that broke — index 2 is an assistant tool-call message
    // whose content is the empty string, so it cannot carry a marker.
    expect(wire[2]).toMatchObject({ role: 'assistant', content: '' })

    const out = applyCacheControl(wire, true, true, 'Current date/time: noon')
    // Before the fix this was [0]: the walk-back skipped the tool at index 3, landed on the
    // unmarkable assistant at 2, and dropped the marker without a word. Now the marker rides
    // that message's tool_call instead.
    expect(markedIndices(out)).toEqual([0, 2])
    expect(out[2].tool_calls?.[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(out[2].content).toBe('')
  })

  test('the same turn WITH preamble lands on the same message, also via its tool call', () => {
    const wire = toORMessages(uiTurn({ preamble: 'Let me read that file.' }), 'SYSTEM PROMPT')
    expect(wire[2]).toMatchObject({ role: 'assistant', content: 'Let me read that file.' })
    const out = applyCacheControl(wire, true, true, 'Current date/time: noon')
    // Whether the model narrated or not no longer changes where the breakpoint goes — which is
    // exactly what the r6/r7-vs-r10..r15 split in process.log was caused by.
    expect(markedIndices(out)).toEqual([0, 2])
    expect(out[2].tool_calls?.[0].cache_control).toEqual({ type: 'ephemeral' })
  })
})

// parallel_write fans N workers out concurrently over one byte-identical shared prefix, so on a
// cold prefix every worker misses the cache and writes it. Priming = one extra maxTokens:1 request
// to warm it first. Whether that pays off is pure arithmetic over pricing already on ModelInfo,
// and it lives in a tested function precisely because it is easy to get backwards by eyeballing:
// the saving GROWS with N, since the single write premium amortizes across more readers.
describe('shouldPrimeCache', () => {
  // Anthropic-shaped ratios: cache write 1.25x the base prompt price, cache read 0.1x.
  const anthropicish: ModelInfo = {
    id: 'anthropic/claude-sonnet-5',
    name: 'Test',
    contextLength: 200_000,
    promptPrice: 0.000001,
    completionPrice: 0.000005,
    cacheReadPrice: 0.0000001,
    cacheWritePrice: 0.00000125,
    supportsExplicitCaching: true,
    supportsTools: true,
    supportsReasoning: false,
    supportsVision: false,
    supportsEmbeddings: false
  }

  const ask = (over: Partial<Parameters<typeof shouldPrimeCache>[0]> = {}) =>
    shouldPrimeCache({
      model: anthropicish,
      prefixTokens: 4000,
      jobCount: 3,
      prefixLastSentAt: null,
      now: 1_000_000,
      ineffective: false,
      ...over
    })

  test('primes for a cold, large-enough prefix shared by 2+ workers', () => {
    const out = ask({ jobCount: 2 })
    expect(out.prime).toBe(true)
    expect(out.primedCostUsd).toBeLessThan(out.unprimedCostUsd)
  })

  test('never primes a single job — there is no one to amortize the write premium over', () => {
    const out = ask({ jobCount: 1 })
    expect(out.prime).toBe(false)
    expect(out.reason).toContain('one job')
  })

  test('the projected saving grows with job count (the direction that is easy to get backwards)', () => {
    const ratio = (n: number) => {
      const d = ask({ jobCount: n })
      return d.primedCostUsd / d.unprimedCostUsd
    }
    expect(ratio(2)).toBeGreaterThan(ratio(3))
    expect(ratio(3)).toBeGreaterThan(ratio(8))
    for (const n of [2, 3, 6, 8]) expect(ask({ jobCount: n }).prime).toBe(true)
  })

  test('does not prime a model that publishes no cache-read price', () => {
    const out = ask({ model: { ...anthropicish, cacheReadPrice: null } })
    expect(out.prime).toBe(false)
    expect(out.reason).toContain('cache-read price')
  })

  test('does not prime an implicit-caching model, where we control no breakpoint', () => {
    const out = ask({ model: { ...anthropicish, supportsExplicitCaching: false } })
    expect(out.prime).toBe(false)
    expect(out.reason).toContain('implicitly')
  })

  test('does not prime below the provider minimum cacheable prefix (a breakpoint there is ignored)', () => {
    expect(ask({ prefixTokens: MIN_CACHEABLE_PREFIX_TOKENS - 1 }).prime).toBe(false)
    expect(ask({ prefixTokens: MIN_CACHEABLE_PREFIX_TOKENS }).prime).toBe(true)
  })

  test('does not prime a model already observed to gain nothing from priming', () => {
    const out = ask({ ineffective: true })
    expect(out.prime).toBe(false)
    expect(out.reason).toContain('no cache reads')
  })

  test('does not prime a prefix sent inside the assumed-warm TTL, but does once it has expired', () => {
    const now = 1_000_000
    expect(ask({ now, prefixLastSentAt: now - (PREFIX_CACHE_TTL_MS - 1000) }).prime).toBe(false)
    expect(ask({ now, prefixLastSentAt: now - (PREFIX_CACHE_TTL_MS + 1000) }).prime).toBe(true)
  })

  // Negative controls: the gate must be driven by the arithmetic, not by "caching is on".
  test('does not prime when the write premium is too expensive to recover', () => {
    const pricey: ModelInfo = { ...anthropicish, cacheWritePrice: 0.000003, cacheReadPrice: 0.0000009 }
    const out = ask({ model: pricey, jobCount: 2 })
    expect(out.prime).toBe(false)
    expect(out.primedCostUsd).toBeGreaterThan(out.unprimedCostUsd)
  })

  test('does not prime on a knife-edge saving that the margin exists to reject', () => {
    // primed/unprimed lands at ~0.9 — a real saving, but inside the margin where our crude token
    // estimate being slightly wrong would flip it into a loss.
    const knifeEdge: ModelInfo = { ...anthropicish, cacheWritePrice: 0.00000125, cacheReadPrice: 0.000000275 }
    const out = ask({ model: knifeEdge, jobCount: 2 })
    expect(out.primedCostUsd).toBeLessThan(out.unprimedCostUsd)
    expect(out.prime).toBe(false)
    expect(out.reason).toContain('margin')
  })

  test('a missing cacheWritePrice is charged at the base prompt price, never assumed free', () => {
    const out = ask({ model: { ...anthropicish, cacheWritePrice: null }, jobCount: 2 })
    // 1.0 write + 2 x 0.1 read = 1.2 vs 2.0 cold — still worth it, but priced honestly.
    expect(out.primedCostUsd).toBeCloseTo(4000 * 0.000001 + 2 * 4000 * 0.0000001, 12)
  })

  test('always reports both projected costs, even when declining to prime', () => {
    const out = ask({ jobCount: 1 })
    expect(out.unprimedCostUsd).toBeGreaterThan(0)
    expect(out.primedCostUsd).toBeGreaterThan(0)
    expect(out.reason.length).toBeGreaterThan(0)
  })
})
