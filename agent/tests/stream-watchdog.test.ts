import { afterEach, describe, expect, it } from 'bun:test'
import {
  MAX_STREAM_ATTEMPTS,
  streamChatCompletion,
  type StreamChunk,
  type StreamTimeouts
} from '../src/main/openrouter/client'
import { describeModelWaiting, formatWaitDuration, modelWaitingDetail } from '../shared/modelWaiting'
import { buildToolArgsRetryNudge } from '../src/main/agent/turnControl'
import type { ModelWaitingInfo } from '../shared/types'

// streamChatCompletion's stall watchdog, exercised end to end against a scripted fetch. Every
// limit is shrunk to milliseconds via the `timeouts` override, so nothing here waits for real.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const FAST: StreamTimeouts = {
  firstTokenMs: 150,
  idleMs: 150,
  totalMs: 5_000,
  tickMs: 20,
  waitingAfterMs: 40,
  retryBackoffMs: 1
}

const KEEP_ALIVE = ': OPENROUTER PROCESSING'
const data = (obj: unknown): string => `data: ${JSON.stringify(obj)}`
const text = (s: string): string => data({ choices: [{ delta: { content: s } }] })
const FINISH = data({ choices: [{ delta: {}, finish_reason: 'stop' }] })
const DONE = 'data: [DONE]'

const abortError = (): Error => new DOMException('aborted', 'AbortError')

/** A scripted SSE body. Each line is enqueued `everyMs` after the previous one; afterwards the
 *  body either closes (`end`) or hangs forever like a stuck upstream. Aborting `signal` errors
 *  the body, as a real fetch does. */
function sse(lines: string[], opts: { everyMs?: number; end?: boolean }, signal?: AbortSignal): Response {
  const enc = new TextEncoder()
  const timers: ReturnType<typeof setTimeout>[] = []
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        'abort',
        () => {
          timers.forEach(clearTimeout)
          try {
            controller.error(abortError())
          } catch {
            /* already closed */
          }
        },
        { once: true }
      )
      const every = opts.everyMs ?? 5
      lines.forEach((line, i) => {
        timers.push(
          setTimeout(() => {
            try {
              controller.enqueue(enc.encode(`${line}\n`))
            } catch {
              /* errored by abort */
            }
          }, every * (i + 1))
        )
      })
      if (opts.end) {
        timers.push(
          setTimeout(() => {
            try {
              controller.close()
            } catch {
              /* errored by abort */
            }
          }, every * (lines.length + 1))
        )
      }
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

type Responder = (signal?: AbortSignal) => Response | Promise<Response>

const healthy: Responder = (signal) => sse([text('o'), text('k'), FINISH, DONE], { end: true }, signal)
/** Headers arrive, then only keep-alive comments: the exact shape of the observed hang. */
const keepAliveHang =
  (everyMs = 30, count = 200): Responder =>
  (signal) =>
    sse(Array(count).fill(KEEP_ALIVE), { everyMs }, signal)
/** fetch() itself never resolves (no response headers ever). */
const neverResponds: Responder = (signal) =>
  new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(abortError()), { once: true }))

/** Installs a fetch mock that serves `responders` in order (the last one repeats). */
function mockFetch(responders: Responder[]): { calls: () => number } {
  let calls = 0
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const responder = responders[Math.min(calls, responders.length - 1)]
    calls++
    return responder(init?.signal ?? undefined)
  }) as unknown as typeof fetch
  return { calls: () => calls }
}

async function run(timeouts: Partial<StreamTimeouts> = FAST, signal?: AbortSignal): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of streamChatCompletion({
    apiKey: 'test-key',
    model: 'test/model',
    messages: [{ role: 'user', content: 'hi' }],
    timeouts,
    signal
  })) {
    out.push(chunk)
  }
  return out
}

const textOf = (chunks: StreamChunk[]): string =>
  chunks
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('')
const waitingOf = (chunks: StreamChunk[]): ModelWaitingInfo[] =>
  chunks.filter((c) => c.type === 'waiting' && c.waiting).map((c) => c.waiting as ModelWaitingInfo)
const errorsOf = (chunks: StreamChunk[]): StreamChunk[] => chunks.filter((c) => c.type === 'error')

describe('streamChatCompletion stall watchdog', () => {
  it('passes a healthy stream through untouched, with no waiting status', async () => {
    const fetchMock = mockFetch([healthy])
    const chunks = await run()
    expect(textOf(chunks)).toBe('ok')
    expect(chunks.some((c) => c.type === 'waiting')).toBe(false)
    expect(errorsOf(chunks)).toHaveLength(0)
    expect(chunks.at(-1)?.type).toBe('done')
    expect(fetchMock.calls()).toBe(1)
  })

  it('does not count keep-alives as progress: a keep-alive-only attempt is abandoned and retried transparently', async () => {
    const fetchMock = mockFetch([keepAliveHang(), healthy])
    const chunks = await run()

    expect(fetchMock.calls()).toBe(2)
    expect(textOf(chunks)).toBe('ok')
    expect(errorsOf(chunks)).toHaveLength(0)

    const waiting = waitingOf(chunks)
    // Surfaced while the first attempt sat silent, reporting the keep-alives it was receiving...
    expect(waiting.some((w) => w.phase === 'first-token' && w.attempt === 1 && w.keepAlives > 0)).toBe(true)
    // ...then immediately on the retry, saying why it is starting over...
    expect(waiting.some((w) => w.attempt === 2 && w.retryReason === 'stall')).toBe(true)
    // ...and cleared once real output arrived.
    const lastWaitingIdx = chunks.map((c) => c.type).lastIndexOf('waiting')
    expect(chunks[lastWaitingIdx].waiting).toBeNull()
  })

  it('still trips when keep-alives arrive faster than the watchdog tick', async () => {
    // A 1 s tick never fires while 10 ms keep-alives keep winning the race, so only the
    // per-chunk check can catch this within the 100 ms first-token limit.
    const fetchMock = mockFetch([keepAliveHang(10, 100), healthy])
    const started = Date.now()
    const chunks = await run({ ...FAST, firstTokenMs: 100, tickMs: 1_000 })
    expect(Date.now() - started).toBeLessThan(800)
    expect(fetchMock.calls()).toBe(2)
    expect(textOf(chunks)).toBe('ok')
  })

  it('abandons a fetch whose response headers never arrive', async () => {
    const fetchMock = mockFetch([neverResponds, healthy])
    const chunks = await run()
    expect(fetchMock.calls()).toBe(2)
    expect(textOf(chunks)).toBe('ok')
    expect(errorsOf(chunks)).toHaveLength(0)
  })

  it('retries a network error that happened before any output', async () => {
    const fetchMock = mockFetch([
      () => {
        throw new TypeError('fetch failed')
      },
      healthy
    ])
    const chunks = await run()
    expect(fetchMock.calls()).toBe(2)
    expect(textOf(chunks)).toBe('ok')
  })

  it('ends in a visible error, not a hang, when every attempt stalls', async () => {
    const fetchMock = mockFetch([keepAliveHang()])
    const chunks = await run()
    expect(fetchMock.calls()).toBe(MAX_STREAM_ATTEMPTS)
    const last = chunks.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.interrupted).toEqual({ reason: 'stall', partialOutput: false })
    expect(last?.error).toContain('No response from test/model')
    expect(last?.error).toContain(`${MAX_STREAM_ATTEMPTS} consecutive attempts`)
  })

  it('reports a stall after partial output as interrupted instead of retrying (no duplicated text)', async () => {
    const fetchMock = mockFetch([
      (signal) => sse([text('partial'), ...Array(200).fill(KEEP_ALIVE)], { everyMs: 20 }, signal),
      healthy
    ])
    const chunks = await run()
    expect(fetchMock.calls()).toBe(1)
    expect(textOf(chunks)).toBe('partial')
    const last = chunks.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.interrupted).toEqual({ reason: 'stall', partialOutput: true })
    // The idle phase is what the waiting status reported once output had started.
    expect(waitingOf(chunks).some((w) => w.phase === 'idle')).toBe(true)
  })

  it('enforces the per-request deadline even while output keeps trickling in', async () => {
    const fetchMock = mockFetch([(signal) => sse(Array(200).fill(text('.')), { everyMs: 10 }, signal)])
    const chunks = await run({ ...FAST, totalMs: 150, idleMs: 10_000 })
    expect(fetchMock.calls()).toBe(1)
    const last = chunks.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.interrupted).toEqual({ reason: 'deadline', partialOutput: true })
    expect(last?.error).toContain('per-request deadline')
  })

  it('ends quietly when the caller aborts during a stall', async () => {
    const fetchMock = mockFetch([keepAliveHang()])
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 60)
    const chunks = await run({ ...FAST, firstTokenMs: 10_000 }, ac.signal)
    expect(fetchMock.calls()).toBe(1)
    expect(errorsOf(chunks)).toHaveLength(0)
  })
})

describe('model-waiting status text', () => {
  const base: ModelWaitingInfo = {
    silentMs: 60_000,
    phase: 'first-token',
    keepAlives: 3,
    stallAfterMs: 360_000,
    attempt: 1,
    maxAttempts: 4
  }

  it('formats durations', () => {
    expect(formatWaitDuration(45_000)).toBe('45s')
    expect(formatWaitDuration(125_000)).toBe('2m 05s')
    expect(formatWaitDuration(-5)).toBe('0s')
  })

  it('distinguishes no-output-yet from paused output', () => {
    expect(describeModelWaiting(base)).toBe('Waiting on the model — 1m 00s with no output yet')
    expect(describeModelWaiting({ ...base, phase: 'idle' })).toContain('since its last output')
  })

  it('explains liveness, the retry, and what happens next', () => {
    const detail = modelWaitingDetail(base)
    expect(detail).toContain('3 keep-alives from OpenRouter')
    expect(detail).toContain('within 5m 00s')
    expect(detail).toContain('retried automatically')
    expect(modelWaitingDetail({ ...base, keepAlives: 0 })).toContain('Nothing has arrived from the provider yet')
    expect(modelWaitingDetail({ ...base, attempt: 2, retryReason: 'stall' })).toContain(
      'Retrying because the previous attempt stalled (attempt 2 of 4)'
    )
    expect(modelWaitingDetail({ ...base, attempt: 4 })).toContain('This is the last attempt')
  })
})

describe("buildToolArgsRetryNudge('interrupted')", () => {
  it('is harness-attributed and says no tool call from the cut attempt ran', () => {
    const nudge = buildToolArgsRetryNudge('interrupted')
    expect(nudge).toContain('not by the user')
    expect(nudge).toContain('none of its tool calls were received or executed')
    expect(nudge).toContain('Do not repeat text you already wrote')
  })
})
