import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { INSPECT_DENY_PATTERNS, commitRefCounter, inspectInPage, withRefLock } from '../src/main/agent/tools/browser'
import type { BrowserSession } from '../src/main/browser/manager'

/* Regression coverage for the element→ref bridge in `inspect`.
 *
 * The bug: `ref()` tags elements via `setAttribute`, which is itself one of the DOM-mutation
 * methods the read-only guards block, and `autoRef()` ran while those guards were still installed.
 * Any inspect call returning a never-before-tagged element therefore failed with the runtime
 * "DOM mutation is blocked" message — the documented `klenny.ref(el)` / return-an-element contract
 * was broken for exactly the elements it's most useful on. It *looked* intermittent because
 * already-tagged (previously snapshotted) elements short-circuit on `getAttribute` and never call
 * `setAttribute` at all.
 *
 * `inspectInPage` is normally serialized into the page by page.evaluate, so exercising it here
 * needs the handful of DOM globals it touches. Anything it reaches with `?.prototype` before
 * handing to its guard installer must exist as a real object: the installer's `key in target`
 * check (and `Object.getOwnPropertyDescriptor` for setters) throws on undefined. */

class FakeElement {
  private readonly attrs = new Map<string, string>()
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) as string) : null
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }
}

class FakeNodeList {
  readonly length: number
  constructor(items: FakeElement[]) {
    this.length = items.length
    items.forEach((item, i) => {
      ;(this as unknown as Record<number, FakeElement>)[i] = item
    })
  }
}

class FakeHTMLCollection extends FakeNodeList {}
class FakeNode {}
class FakeHTMLElement extends FakeElement {}
class FakeStub {}

const GLOBAL_KEYS = [
  'window',
  'Element',
  'Node',
  'HTMLElement',
  'NodeList',
  'HTMLCollection',
  'XMLHttpRequest',
  'Document',
  'History',
  'Location',
  'HTMLFormElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'EventTarget',
  '__testTarget',
  '__testTargets'
] as const

const g = globalThis as unknown as Record<string, unknown>
const saved = new Map<string, unknown>()

const STUBS: Record<string, unknown> = {
  Element: FakeElement,
  Node: FakeNode,
  HTMLElement: FakeHTMLElement,
  NodeList: FakeNodeList,
  HTMLCollection: FakeHTMLCollection,
  XMLHttpRequest: FakeStub,
  Document: FakeStub,
  History: FakeStub,
  Location: FakeStub,
  HTMLFormElement: FakeStub,
  HTMLInputElement: FakeStub,
  HTMLTextAreaElement: FakeStub,
  HTMLSelectElement: FakeStub,
  EventTarget: FakeStub
}

beforeAll(() => {
  for (const key of GLOBAL_KEYS) saved.set(key, g[key])
  for (const [key, value] of Object.entries(STUBS)) g[key] = value

  // A distinct object rather than globalThis, so the guards that patch `window.eval`/
  // `window.Function` can't disturb the real test-runner globals.
  g.window = { ...STUBS }
})

/** Runs `fn` with `window` temporarily replaced by `{...STUBS, ...overrides}` — used to simulate
 *  hostile/unavailable browser APIs (e.g. a `localStorage` getter that throws, as Chromium does on
 *  a `data:` URL) without disturbing the other tests. */
async function withWindow<T>(overrides: PropertyDescriptorMap, fn: () => Promise<T>): Promise<T> {
  const previous = g.window
  const replacement: Record<string, unknown> = { ...STUBS }
  Object.defineProperties(replacement, overrides)
  g.window = replacement
  try {
    return await fn()
  } finally {
    g.window = previous
  }
}

afterEach(() => {
  delete g.__testTarget
  delete g.__testTargets
})

afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete g[key]
    else g[key] = value
  }
})

describe('inspect element→ref bridge (ref-tagging must survive its own read-only guards)', () => {
  test('returning a never-snapshotted element yields a ref instead of a DOM-mutation error', async () => {
    const el = new FakeElement()
    g.__testTarget = el

    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })

    expect(outcome.ok).toBe(true)
    expect(outcome.error).toBeUndefined()
    expect(outcome.result).toBe('e0')
    expect(outcome.nextCounter).toBe(1)
    expect(el.getAttribute('data-klenny-ref')).toBe('e0')
  })

  test('ref numbering continues from the counter snapshot() already handed out', async () => {
    g.__testTarget = new FakeElement()

    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 7 })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toBe('e7')
    expect(outcome.nextCounter).toBe(8)
  })

  test('returning an array of untagged elements yields one ref each', async () => {
    const els = [new FakeElement(), new FakeElement(), new FakeElement()]
    g.__testTargets = els

    const outcome = await inspectInPage({ code: 'globalThis.__testTargets', start: 0 })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual(['e0', 'e1', 'e2'])
    expect(outcome.nextCounter).toBe(3)
    expect(els.map((e) => e.getAttribute('data-klenny-ref'))).toEqual(['e0', 'e1', 'e2'])
  })

  test('returning a NodeList yields refs (the querySelectorAll shape that failed in practice)', async () => {
    const els = [new FakeElement(), new FakeElement()]
    g.__testTargets = new FakeNodeList(els)

    const outcome = await inspectInPage({ code: 'globalThis.__testTargets', start: 4 })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual(['e4', 'e5'])
    expect(outcome.nextCounter).toBe(6)
  })

  test('an explicit klenny.ref(el) call in model code works too, not just returned elements', async () => {
    const el = new FakeElement()
    g.__testTarget = el

    const outcome = await inspectInPage({ code: 'klenny.ref(globalThis.__testTarget)', start: 2 })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toBe('e2')
    expect(el.getAttribute('data-klenny-ref')).toBe('e2')
  })

  test('an already-tagged element returns its existing ref without re-tagging or burning a number', async () => {
    const el = new FakeElement()
    el.setAttribute('data-klenny-ref', 'e3')
    g.__testTarget = el

    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 9 })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toBe('e3')
    expect(outcome.nextCounter).toBe(9)
    expect(el.getAttribute('data-klenny-ref')).toBe('e3')
  })

  test('mixed tagged/untagged elements each resolve correctly in one call', async () => {
    const tagged = new FakeElement()
    tagged.setAttribute('data-klenny-ref', 'e1')
    const untagged = new FakeElement()
    g.__testTargets = [tagged, untagged]

    const outcome = await inspectInPage({ code: 'globalThis.__testTargets', start: 5 })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual(['e1', 'e5'])
    expect(outcome.nextCounter).toBe(6)
  })
})

describe('inspect read-only guarantee is not widened by the ref fix', () => {
  test('model code calling el.setAttribute directly is still blocked at runtime', async () => {
    const el = new FakeElement()
    g.__testTarget = el

    const outcome = await inspectInPage({ code: "globalThis.__testTarget.setAttribute('data-evil', '1')", start: 0 })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('read-only')
    expect(outcome.error).toContain('DOM mutation')
    expect(el.getAttribute('data-evil')).toBeNull()
  })

  test('model code cannot forge a ref tag on an element it never legitimately tagged', async () => {
    const el = new FakeElement()
    g.__testTarget = el

    const outcome = await inspectInPage({ code: "globalThis.__testTarget.setAttribute('data-klenny-ref', 'e999')", start: 0 })

    expect(outcome.ok).toBe(false)
    expect(el.getAttribute('data-klenny-ref')).toBeNull()
  })

  test('guards are restored after the call, including the setAttribute used by ref-tagging', async () => {
    g.__testTarget = new FakeElement()
    await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })

    const after = new FakeElement()
    after.setAttribute('data-normal', 'ok')
    expect(after.getAttribute('data-normal')).toBe('ok')
  })

  test('guards are restored even when the model code throws', async () => {
    const outcome = await inspectInPage({ code: "(() => { throw new Error('boom') })()", start: 0 })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('boom')

    const after = new FakeElement()
    after.setAttribute('data-normal', 'ok')
    expect(after.getAttribute('data-normal')).toBe('ok')
  })

  test('primitive results still pass through untouched (the reliable workaround pattern)', async () => {
    const outcome = await inspectInPage({ code: '({ rowCount: 3, hasError: false, title: "x" })', start: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual({ rowCount: 3, hasError: false, title: 'x' })
    expect(outcome.nextCounter).toBe(0)
  })
})

/* ------------------------------------------------------------------------------------------------
 * Bug 1: ref-counter race → duplicate refs on different elements.
 * ---------------------------------------------------------------------------------------------- */

describe('per-tab ref-counter locking (withRefLock + commitRefCounter)', () => {
  function fakeSession(): BrowserSession {
    return { refCounters: new Map<string, number>() } as unknown as BrowserSession
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** Mimics doInspect/doSnapshot's read→evaluate→commit, *without* the lock (the old behavior). */
  async function mintUnlocked(session: BrowserSession, tab: string, count: number, delayMs: number): Promise<string[]> {
    const start = session.refCounters.get(tab) ?? 0
    await sleep(delayMs)
    const minted = Array.from({ length: count }, (_, i) => `e${start + i}`)
    session.refCounters.set(tab, start + count)
    return minted
  }

  /** The same sequence as it is now: serialized, and committed monotonically. */
  async function mintLocked(session: BrowserSession, tab: string, count: number, delayMs: number): Promise<string[]> {
    return withRefLock(session, tab, async () => {
      const start = session.refCounters.get(tab) ?? 0
      await sleep(delayMs)
      const minted = Array.from({ length: count }, (_, i) => `e${start + i}`)
      commitRefCounter(session, tab, start + count)
      return minted
    })
  }

  // Characterization of the *bug*, kept so the fix below is demonstrably load-bearing: this is the
  // reported repro (counter at 1, three parallel calls minting 2/1/0 refs) and it must show both
  // failure modes — a duplicate ref, and the counter rolling backward.
  test('WITHOUT the lock, parallel mints collide and roll the counter backward (the reported bug)', async () => {
    const session = fakeSession()
    session.refCounters.set('main', 1)

    // Delays ordered so the *smallest* commit lands last, reproducing the backward roll.
    const [a, b, c] = await Promise.all([
      mintUnlocked(session, 'main', 2, 5),
      mintUnlocked(session, 'main', 1, 20),
      mintUnlocked(session, 'main', 0, 35)
    ])

    expect(a).toEqual(['e1', 'e2'])
    expect(b).toEqual(['e1']) // collides with a's first ref — two elements, one ref
    expect(c).toEqual([])
    const all = [...a, ...b, ...c]
    expect(new Set(all).size).toBeLessThan(all.length) // duplicates present
    expect(session.refCounters.get('main')).toBe(1) // rolled back from 3 → 1
  })

  test('WITH the lock, the same parallel batch mints strictly disjoint refs', async () => {
    const session = fakeSession()
    session.refCounters.set('main', 1)

    const [a, b, c] = await Promise.all([
      mintLocked(session, 'main', 2, 5),
      mintLocked(session, 'main', 1, 20),
      mintLocked(session, 'main', 0, 35)
    ])

    const all = [...a, ...b, ...c]
    expect(new Set(all).size).toBe(all.length) // no duplicates
    expect(all).toEqual(['e1', 'e2', 'e3'])
    expect(session.refCounters.get('main')).toBe(4) // never regresses
  })

  test('many concurrent mints on one tab: every ref distinct, counter equals total minted', async () => {
    const session = fakeSession()
    const batches = await Promise.all(
      Array.from({ length: 12 }, (_, i) => mintLocked(session, 'main', 3, (12 - i) * 2))
    )
    const all = batches.flat()
    expect(all.length).toBe(36)
    expect(new Set(all).size).toBe(36)
    expect(session.refCounters.get('main')).toBe(36)
  })

  test('a parallel inspect+snapshot on the same tab produce no overlapping refs', async () => {
    const session = fakeSession()
    // Stand-ins for the two callers that share one counter.
    const [inspectRefs, snapshotRefs] = await Promise.all([mintLocked(session, 'main', 2, 15), mintLocked(session, 'main', 5, 3)])
    const overlap = inspectRefs.filter((r) => snapshotRefs.includes(r))
    expect(overlap).toEqual([])
    expect(session.refCounters.get('main')).toBe(7)
  })

  test('different tabs are not serialized against each other and keep independent counters', async () => {
    const session = fakeSession()
    const started = Date.now()
    const [one, two] = await Promise.all([mintLocked(session, 'tab-a', 1, 40), mintLocked(session, 'tab-b', 1, 40)])
    const elapsed = Date.now() - started

    expect(one).toEqual(['e0'])
    expect(two).toEqual(['e0']) // same ref number is fine — different tabs, different documents
    expect(session.refCounters.get('tab-a')).toBe(1)
    expect(session.refCounters.get('tab-b')).toBe(1)
    expect(elapsed).toBeLessThan(75) // ran concurrently, not back-to-back
  })

  test('one failing call does not poison the queue for calls behind it', async () => {
    const session = fakeSession()
    const failing = withRefLock(session, 'main', async () => {
      throw new Error('inspect blew up')
    })
    await expect(failing).rejects.toThrow('inspect blew up')

    const after = await mintLocked(session, 'main', 2, 1)
    expect(after).toEqual(['e0', 'e1'])
    expect(session.refCounters.get('main')).toBe(2)
  })

  test('commitRefCounter is monotonic, but navigate can still reset to 0 deliberately', () => {
    const session = fakeSession()
    commitRefCounter(session, 'main', 5)
    expect(session.refCounters.get('main')).toBe(5)

    commitRefCounter(session, 'main', 2) // a late straggler must not roll it back
    expect(session.refCounters.get('main')).toBe(5)

    // navigate() bypasses commitRefCounter on purpose — the old document's refs are meaningless.
    session.refCounters.set('main', 0)
    expect(session.refCounters.get('main')).toBe(0)
    commitRefCounter(session, 'main', 1)
    expect(session.refCounters.get('main')).toBe(1)
  })
})

/* ------------------------------------------------------------------------------------------------
 * Bug 2: autoRef didn't recurse into plain objects → silent "ref: <Node>" garbage.
 * ---------------------------------------------------------------------------------------------- */

describe('autoRef recurses into plain objects (no silent "ref: <Node>" degradation)', () => {
  test('an element nested in a plain object becomes a ref', async () => {
    g.__testTarget = { header: new FakeElement() }
    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual({ header: 'e0' })
  })

  test('elements are reffed at every depth, including inside nested objects and arrays', async () => {
    g.__testTarget = { a: new FakeElement(), nested: { b: [new FakeElement()], deep: { c: new FakeElement() } } }
    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual({ a: 'e0', nested: { b: ['e1'], deep: { c: 'e2' } } })
    expect(outcome.nextCounter).toBe(3)
  })

  // The exact shape from the bug report, which used to come back as
  // {"twice": ["ref: <Node>","ref: <Node>"], "nodelist": {"0": "ref: <Node>"}}.
  test('the reported shape {twice: [el, el], nodelist: NodeList} now resolves fully', async () => {
    const el = new FakeElement()
    g.__testTarget = { twice: [el, el], nodelist: new FakeNodeList([new FakeElement()]) }

    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })

    expect(outcome.ok).toBe(true)
    // Same element twice → the same ref both times (a DAG, not a cycle), and the nested NodeList
    // becomes a proper array of refs rather than an index-keyed object of junk.
    expect(outcome.result).toEqual({ twice: ['e0', 'e0'], nodelist: ['e1'] })
    expect(outcome.nextCounter).toBe(2)
  })

  test('a NodeList nested inside an object is converted (top level is no longer the only case)', async () => {
    g.__testTarget = { matches: new FakeNodeList([new FakeElement(), new FakeElement()]) }
    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 3 })
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual({ matches: ['e3', 'e4'] })
  })

  test('a circular structure is reported as [circular] instead of hanging or overflowing', async () => {
    const cyclic: Record<string, unknown> = { el: new FakeElement() }
    cyclic.self = cyclic
    g.__testTarget = cyclic

    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })

    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual({ el: 'e0', self: '[circular]' })
  })

  test('class instances are left alone rather than being flattened into plain objects', async () => {
    class Custom {
      constructor(public label: string) {}
    }
    const instance = new Custom('keep-me')
    g.__testTarget = { wrapped: instance }

    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })

    expect(outcome.ok).toBe(true)
    expect((outcome.result as { wrapped: unknown }).wrapped).toBe(instance)
  })

  test('primitives and nulls inside objects survive the recursion unchanged', async () => {
    g.__testTarget = { n: 1, s: 'x', b: false, nul: null, arr: [1, 'two'] }
    const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toEqual({ n: 1, s: 'x', b: false, nul: null, arr: [1, 'two'] })
    expect(outcome.nextCounter).toBe(0)
  })
})

/* ------------------------------------------------------------------------------------------------
 * Bug 3: INSPECT_DENY_PATTERNS false-positived on `===` comparisons.
 * ---------------------------------------------------------------------------------------------- */

describe('INSPECT_DENY_PATTERNS: comparisons allowed, assignments still blocked', () => {
  function denialLabel(code: string): string | null {
    for (const { pattern, label } of INSPECT_DENY_PATTERNS) if (pattern.test(code)) return label
    return null
  }

  test.each([
    ["document.querySelector('h1').textContent === 'Example Domain'"],
    ["el.textContent == 'x'"],
    ["el.innerText === 'y'"],
    ['el.innerHTML === other.innerHTML'],
    ['el.outerHTML === snapshotHtml'],
    ["input.value === 'typed'"],
    ["[...document.querySelectorAll('p')].filter((p) => p.textContent === 'match').length"]
  ])('allows the read-only comparison: %s', (code) => {
    expect(denialLabel(code)).toBeNull()
  })

  test.each([
    ["el.textContent = 'x'", 'DOM content assignment'],
    ["el.innerText = 'x'", 'DOM content assignment'],
    ["el.innerHTML = '<b>x</b>'", 'DOM content assignment'],
    ["el.outerHTML = '<b>x</b>'", 'DOM content assignment'],
    ["input.value = 'x'", 'form value assignment'],
    ['el.textContent  =  "spaced"', 'DOM content assignment']
  ])('still blocks the assignment: %s', (code, label) => {
    expect(denialLabel(code)).toBe(label)
  })
})

/* ------------------------------------------------------------------------------------------------
 * Bug 4: reading localStorage threw on `data:` URLs, killing inspect before any code ran.
 * ---------------------------------------------------------------------------------------------- */

describe('inspect survives origins where browser APIs throw on access (data: URLs)', () => {
  const throwingGetter = (message: string) => ({
    get() {
      throw new Error(message)
    },
    configurable: true
  })

  test("a localStorage getter that throws (Chromium's data: URL behavior) no longer aborts inspect", async () => {
    await withWindow(
      {
        localStorage: throwingGetter("SecurityError: Failed to read the 'localStorage' property from 'Window': Storage is disabled inside 'data:' URLs."),
        sessionStorage: throwingGetter("SecurityError: Failed to read the 'sessionStorage' property from 'Window': Storage is disabled inside 'data:' URLs.")
      },
      async () => {
        const outcome = await inspectInPage({ code: '({ ok: 1 })', start: 0 })
        expect(outcome.ok).toBe(true)
        expect(outcome.result).toEqual({ ok: 1 })
      }
    )
  })

  test('ref-tagging still works on such an origin', async () => {
    await withWindow({ localStorage: throwingGetter('SecurityError: storage disabled') }, async () => {
      g.__testTarget = new FakeElement()
      const outcome = await inspectInPage({ code: 'globalThis.__testTarget', start: 0 })
      expect(outcome.ok).toBe(true)
      expect(outcome.result).toBe('e0')
    })
  })

  test('any other throwing-getter API (e.g. indexedDB) also fails soft rather than aborting', async () => {
    await withWindow({ indexedDB: throwingGetter('SecurityError: indexedDB unavailable') }, async () => {
      const outcome = await inspectInPage({ code: '1 + 1', start: 0 })
      expect(outcome.ok).toBe(true)
      expect(outcome.result).toBe(2)
    })
  })
})
