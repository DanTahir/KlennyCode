import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { inspectInPage } from '../src/main/agent/tools/browser'

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

beforeAll(() => {
  for (const key of GLOBAL_KEYS) saved.set(key, g[key])

  const stubs: Record<string, unknown> = {
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
  for (const [key, value] of Object.entries(stubs)) g[key] = value

  // A distinct object rather than globalThis, so the guards that patch `window.eval`/
  // `window.Function` can't disturb the real test-runner globals.
  g.window = { ...stubs }
})

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
