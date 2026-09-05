// Regression tests for the "browser inspect hung the whole app" incident.
//
// What actually happened (the failure this file exists to prevent):
//   1. An `inspect` call ran a snippet doing getImageData() on a canvas driven by a heavy WebGL2
//      render loop. The snippet outlived inspect's 15s deadline.
//   2. That deadline fired *correctly* — it was already implemented.
//   3. Its error path then called recoverRefCounterFromDom(), which did an **unbounded**
//      page.evaluate(). Playwright's page.evaluate() has no timeout option and needs the page's
//      main thread to be free to run at all, so it queued behind the very snippet that had just
//      timed out and waited forever.
//   4. So the tool call never returned. Stop didn't help (nothing raced the abort signal), and
//      because launchAgentLoop() serializes a tab's runs, the next queued user message couldn't be
//      appended either — which is why it looked like the app had swallowed the user's chat
//      messages. Only closing the browser window (rejecting the pending evaluate) broke it.
//
// The invariant being pinned: every page.evaluate() in browser.ts goes through raceDeadline(), so
// no browser code path can ever wait unboundedly, *including on its own error/recovery paths*.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { raceDeadline } from '../src/main/agent/tools/browser'

const BROWSER_SRC = readFileSync(join(import.meta.dir, '../src/main/agent/tools/browser.ts'), 'utf8')

/** A promise that never settles — stands in for an evaluate wedged behind a busy main thread. */
function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => undefined)
}

describe('raceDeadline', () => {
  test('passes through the resolved value when the promise beats the deadline', async () => {
    expect(await raceDeadline(Promise.resolve('ok'), 1000, 'Inspect')).toBe('ok')
  })

  test('propagates a real rejection unchanged (not masked as a timeout)', async () => {
    await expect(raceDeadline(Promise.reject(new Error('boom')), 1000, 'Inspect')).rejects.toThrow('boom')
  })

  test('rejects a never-settling promise once the deadline passes, instead of hanging forever', async () => {
    await expect(raceDeadline(neverSettles(), 20, 'Inspect')).rejects.toThrow(/Inspect timed out after/)
  })

  test('timeout message names the actual cause (busy main thread), not just "infinite loop"', async () => {
    // The old message blamed "an infinite loop or unresolved await", which sent me looking at the
    // snippet instead of at the blocked renderer. Keep the real cause in the text.
    await expect(raceDeadline(neverSettles(), 20, 'Inspect')).rejects.toThrow(/main thread is likely blocked/)
  })

  test('rejects as soon as the signal aborts, even though the underlying promise never settles', async () => {
    // This is the "Stop actually does something" guarantee for an in-flight browser op.
    const ac = new AbortController()
    const pending = raceDeadline(neverSettles(), 60_000, 'Inspect', ac.signal)
    ac.abort()
    await expect(pending).rejects.toThrow('Inspect cancelled by user')
  })

  test('rejects immediately when handed an already-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(raceDeadline(neverSettles(), 60_000, 'Evaluate', ac.signal)).rejects.toThrow('Evaluate cancelled by user')
  })

  test('abort wins well before the deadline would have fired', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const pending = raceDeadline(neverSettles(), 30_000, 'Snapshot', ac.signal)
    ac.abort()
    await expect(pending).rejects.toThrow(/cancelled by user/)
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('an abandoned promise that rejects later does not become an unhandled rejection', async () => {
    // raceDeadline stops observing the promise on timeout; if it isn't claimed, a later rejection
    // is an unhandled rejection, which in Electron's main process is fatal.
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      let rejectLater: (e: Error) => void = () => undefined
      const slow = new Promise<string>((_, reject) => {
        rejectLater = reject
      })
      await expect(raceDeadline(slow, 20, 'Inspect')).rejects.toThrow(/timed out/)
      rejectLater(new Error('late failure from the abandoned evaluate'))
      await new Promise((r) => setTimeout(r, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('clears its timer on the success path (no lingering handle keeping the loop alive)', async () => {
    // A leaked 5-minute timer per call would keep the process from settling; assert the fast path
    // resolves and nothing throws afterward.
    const started = Date.now()
    expect(await raceDeadline(Promise.resolve(1), 300_000, 'Inspect')).toBe(1)
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe('no unbounded page.evaluate remains in browser.ts', () => {
  test('every page.evaluate call site is wrapped in raceDeadline', () => {
    // Structural guard: this is the invariant that was violated. A future contributor adding a
    // bare `await page.evaluate(...)` — especially on an error path, which is exactly where the
    // original bug hid — reintroduces the hang, so fail the build instead.
    const lines = BROWSER_SRC.split('\n')
    const offenders: string[] = []
    lines.forEach((line, i) => {
      if (!line.includes('page.evaluate(')) return
      if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) return
      // Wrapped calls appear either as `raceDeadline(page.evaluate(...)` on one line, or as
      // `page.evaluate(` on the line directly after a `raceDeadline(` opener.
      const wrappedInline = line.includes('raceDeadline(')
      const wrappedAbove = i > 0 && lines[i - 1].includes('raceDeadline(')
      if (!wrappedInline && !wrappedAbove) offenders.push(`${i + 1}: ${line.trim()}`)
    })
    expect(offenders).toEqual([])
  })

  test('the recovery path specifically is bounded (the exact regression that hung the app)', () => {
    const fn = BROWSER_SRC.slice(
      BROWSER_SRC.indexOf('async function recoverRefCounterFromDom'),
      BROWSER_SRC.indexOf('function networkPolicyOptions')
    )
    expect(fn).toContain('raceDeadline')
    expect(fn).toContain('REF_RECOVERY_TIMEOUT_MS')
  })

  test('inspect, evaluate and snapshot all pass the abort signal through', () => {
    // Collect the text of each raceDeadline(...) *call site* (skipping the declaration and the
    // constant definitions, which also mention the marker names).
    const callSites: string[] = []
    let from = BROWSER_SRC.indexOf('raceDeadline(')
    while (from !== -1) {
      const preceding = BROWSER_SRC.slice(Math.max(0, from - 30), from)
      if (!preceding.includes('function ')) callSites.push(BROWSER_SRC.slice(from, from + 400))
      from = BROWSER_SRC.indexOf('raceDeadline(', from + 1)
    }
    expect(callSites.length).toBeGreaterThanOrEqual(4)

    // Each user-facing action must hand its deadline AND the run's abort signal to raceDeadline,
    // so Stop interrupts an in-flight page operation.
    for (const marker of ['INSPECT_TIMEOUT_MS', 'EVALUATE_TIMEOUT_MS', 'SNAPSHOT_TIMEOUT_MS']) {
      const site = callSites.find((s) => s.includes(marker))
      expect(site, `no raceDeadline call site uses ${marker}`).toBeDefined()
      expect(site).toContain('ctx.signal')
    }

    // The recovery path is the deliberate exception: bounded, but intentionally not cancellable
    // (see its comment) so a stopped run still resyncs the ref counter.
    const recoverySite = callSites.find((s) => s.includes('REF_RECOVERY_TIMEOUT_MS'))
    expect(recoverySite).toBeDefined()
    expect(recoverySite).not.toContain('ctx.signal')
  })

  test('recovery deadline is short, and all deadlines are bounded', () => {
    const constant = (name: string): number => {
      const m = new RegExp(`const ${name} = ([0-9_]+)`).exec(BROWSER_SRC)
      if (!m) throw new Error(`${name} not found`)
      return Number(m[1].replace(/_/g, ''))
    }
    // The recovery path runs while the main thread is probably still blocked, so it must not sit
    // there long; the others are synchronous tool calls the model is waiting on.
    expect(constant('REF_RECOVERY_TIMEOUT_MS')).toBeLessThanOrEqual(5_000)
    expect(constant('INSPECT_TIMEOUT_MS')).toBeLessThanOrEqual(60_000)
    expect(constant('SNAPSHOT_TIMEOUT_MS')).toBeLessThanOrEqual(60_000)
    expect(constant('EVALUATE_TIMEOUT_MS')).toBeLessThanOrEqual(60_000)
  })
})

describe('orchestrator races tool execution against the abort signal', () => {
  test('loop.ts does not await tool execution unconditionally', () => {
    // The Stop fix: awaiting Promise.all directly means a wedged tool blocks the turn (and the
    // next queued user message) forever, no matter what Stop does.
    const loopSrc = readFileSync(join(import.meta.dir, '../src/main/agent/orchestrator/loop.ts'), 'utf8')
    expect(loopSrc).not.toContain('const results = await Promise.all(')
    expect(loopSrc).toContain('const toolExecution = Promise.all(')
    const race = loopSrc.slice(loopSrc.indexOf('const toolExecution = Promise.all('))
    expect(race).toContain("signal.addEventListener('abort'")
    expect(race).toContain('void toolExecution.catch(')
  })
})
