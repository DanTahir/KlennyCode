import { describe, expect, test } from 'bun:test'
import { evaluateNavigation } from '../src/main/browser/network-policy'
import {
  isBrowserActionMutating,
  MUTATING_BROWSER_ACTIONS,
  browserTool,
  resolveViewport,
  summarizeSnapshot,
  screenshotResultData,
  VIEWPORT_PRESETS
} from '../src/main/agent/tools/browser'
import { compactToolResult } from '../src/main/agent/messages'
import { DEFAULT_BROWSER_AUTOMATION, MUTATING_TOOLS } from '@shared/types'
import { getToolDefinitions } from '../src/main/agent/tools/definitions'

describe('browser automation defaults', () => {
  test('DEFAULT_BROWSER_AUTOMATION is off by default with the documented safe defaults', () => {
    expect(DEFAULT_BROWSER_AUTOMATION.policy).toBe('off')
    expect(DEFAULT_BROWSER_AUTOMATION.headlessForUnattendedRuns).toBe(true)
    expect(DEFAULT_BROWSER_AUTOMATION.allowPrivateNetwork).toBe(true)
    expect(DEFAULT_BROWSER_AUTOMATION.allowPrivateNetworkUnattended).toBe(false)
    expect(DEFAULT_BROWSER_AUTOMATION.allowEvaluate).toBe(false)
    expect(DEFAULT_BROWSER_AUTOMATION.browserExecutablePath).toBeNull()
    expect(DEFAULT_BROWSER_AUTOMATION.maxConcurrentSessions).toBe(3)
  })

  test('browser is classified as a mutating tool for reasoning-effort escalation', () => {
    expect(MUTATING_TOOLS).toContain('browser')
  })
})

describe('browser tool definition + allowlisting', () => {
  test('agent mode includes the browser tool when browserAutomationAvailable is true', () => {
    const tools = getToolDefinitions('agent', undefined, false, true, false, { browserAutomationAvailable: true }).map(
      (t) => t.function.name
    )
    expect(tools).toContain('browser')
  })

  test('browser tool is hidden by default (browserAutomationAvailable defaults to false/absent, matching policy=off)', () => {
    const tools = getToolDefinitions('agent').map((t) => t.function.name)
    expect(tools).not.toContain('browser')
  })

  test('plan mode excludes the browser tool regardless of browserAutomationAvailable (mutating-capable, agent-mode only)', () => {
    const tools = getToolDefinitions('plan', undefined, false, true, false, { browserAutomationAvailable: true }).map(
      (t) => t.function.name
    )
    expect(tools).not.toContain('browser')
  })

  test('browser tool is available with no workspace open (Assistant tab) since it needs no file I/O', () => {
    const tools = getToolDefinitions('agent', 'all', false, false, false, { browserAutomationAvailable: true }).map(
      (t) => t.function.name
    )
    expect(tools).toContain('browser')
  })

  test('restrictTo can exclude browser for a restricted subagent type even when browserAutomationAvailable is true', () => {
    const tools = getToolDefinitions('agent', ['read_file', 'grep'], false, true, false, { browserAutomationAvailable: true }).map(
      (t) => t.function.name
    )
    expect(tools).not.toContain('browser')
  })

  test("restrictTo 'all' keeps browser available when browserAutomationAvailable is true", () => {
    const tools = getToolDefinitions('agent', 'all', false, true, false, { browserAutomationAvailable: true }).map(
      (t) => t.function.name
    )
    expect(tools).toContain('browser')
  })
})

describe('isBrowserActionMutating', () => {
  test('classifies click/type/fill/select/press_key/scroll/drag/submit/evaluate as mutating', () => {
    for (const action of ['click', 'type', 'fill', 'select', 'press_key', 'scroll', 'drag', 'submit', 'evaluate']) {
      expect(isBrowserActionMutating(action)).toBe(true)
    }
    expect(MUTATING_BROWSER_ACTIONS.size).toBe(9)
  })

  test('classifies open/close/list_tabs/navigate/snapshot/screenshot/resize/wait_for/wait as non-mutating (always allowed unless policy=off)', () => {
    for (const action of ['open', 'close', 'list_tabs', 'navigate', 'snapshot', 'screenshot', 'resize', 'wait_for', 'wait']) {
      expect(isBrowserActionMutating(action)).toBe(false)
    }
  })

  test('resize is non-mutating — it reframes our own view, it does not change the page or the user\'s data', () => {
    expect(isBrowserActionMutating('resize')).toBe(false)
    expect(MUTATING_BROWSER_ACTIONS.has('resize')).toBe(false)
  })

  test('unknown actions are treated as non-mutating (fail via the unknown_action branch, not gated as mutating)', () => {
    expect(isBrowserActionMutating('teleport')).toBe(false)
  })

  test('inspect is non-mutating — never queued for approval, unlike evaluate', () => {
    expect(isBrowserActionMutating('inspect')).toBe(false)
  })
})

describe("browser 'inspect' action (read-only JS evaluation)", () => {
  const baseCtx = { ownerId: 'test-owner-inspect', unattended: false, settings: DEFAULT_BROWSER_AUTOMATION }
  const unattendedCtx = { ownerId: 'test-owner-inspect-unattended', unattended: true, settings: DEFAULT_BROWSER_AUTOMATION }

  test('requires code', async () => {
    const result = await browserTool({ action: 'inspect' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('missing_code')
  })

  test.each([
    ['fetch(', "fetch('/api/x')"],
    ['XMLHttpRequest', 'new XMLHttpRequest()'],
    ['storage mutation', "localStorage.setItem('a', 'b')"],
    ['document.cookie =', "document.cookie = 'x=1'"],
    ['click(', "document.querySelector('button').click()"],
    ['form submit', "document.querySelector('form').submit()"],
    ['DOM mutation method', "document.body.appendChild(document.createElement('div'))"],
    ['DOM content assignment', "document.body.innerHTML = '<b>x</b>'"],
    ['form value assignment', "document.querySelector('input').value = 'x'"],
    ['eval(', "eval('1+1')"],
    ['new Function(', "new Function('return 1')()"],
    ['location navigation', "location.href = 'https://evil.example'"],
    ['window.open(', "window.open('https://evil.example')"]
  ])('statically rejects code containing %s before ever touching the page', async (_label, code) => {
    const result = await browserTool({ action: 'inspect', code }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('inspect_denied_pattern')
  })

  test('evaluate is still hard-blocked for unattended contexts regardless of settings (unchanged)', async () => {
    const result = await browserTool({ action: 'evaluate', code: 'document.title' }, unattendedCtx)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('evaluate_forbidden_unattended')
  })
})

describe('browser tool definition includes inspect', () => {
  test('the inspect action is a valid enum value on the browser tool schema', () => {
    const tools = getToolDefinitions('agent', undefined, false, true, false, { browserAutomationAvailable: true })
    const browserDef = tools.find((t) => t.function.name === 'browser')
    const actionEnum = (browserDef?.function.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum
    expect(actionEnum).toContain('inspect')
  })
})

describe('browser resize action (viewport control for responsive/mobile checks)', () => {
  const baseCtx = { ownerId: 'test-owner-resize', unattended: false, settings: DEFAULT_BROWSER_AUTOMATION }

  test('resize is a valid enum value on the browser tool schema', () => {
    const tools = getToolDefinitions('agent', undefined, false, true, false, { browserAutomationAvailable: true })
    const browserDef = tools.find((t) => t.function.name === 'browser')
    const props = (browserDef?.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties
    expect(props.action.enum).toContain('resize')
    // The knobs the model needs to actually use it must be advertised too.
    expect(props.width).toBeDefined()
    expect(props.height).toBeDefined()
    expect(props.preset?.enum).toEqual(['mobile', 'tablet', 'desktop', 'wide'])
  })

  test('a preset resolves to its documented size', () => {
    expect(resolveViewport({ preset: 'mobile' })).toEqual({ width: 390, height: 844 })
    expect(resolveViewport({ preset: 'wide' })).toEqual(VIEWPORT_PRESETS.wide)
  })

  test('preset matching is case/whitespace tolerant', () => {
    expect(resolveViewport({ preset: '  Mobile ' })).toEqual({ width: 390, height: 844 })
  })

  test('width alone is allowed and completes the height from the fallback (the common mobile check)', () => {
    expect(resolveViewport({ width: 360 }, { width: 1280, height: 720 })).toEqual({ width: 360, height: 720 })
  })

  test('an explicit dimension overrides the corresponding preset dimension', () => {
    expect(resolveViewport({ preset: 'mobile', width: 320 })).toEqual({ width: 320, height: 844 })
  })

  test('fractional dimensions are rounded rather than rejected', () => {
    expect(resolveViewport({ width: 390.6, height: 844.2 })).toEqual({ width: 391, height: 844 })
  })

  test('supplying nothing is an error rather than silently resolving to a default size', () => {
    expect(resolveViewport({})).toEqual({ error: 'missing_viewport', summary: expect.any(String) })
  })

  test('an unknown preset names the valid ones instead of failing opaquely', () => {
    const result = resolveViewport({ preset: 'phone' })
    expect(result).toMatchObject({ error: 'unknown_preset' })
    expect((result as { summary: string }).summary).toContain('mobile')
  })

  test.each([
    ['zero', 0],
    ['negative', -390],
    ['absurdly large', 99_999],
    ['NaN', Number.NaN]
  ])('a %s dimension is rejected, so a degenerate viewport cannot poison later snapshots', (_label, width) => {
    expect(resolveViewport({ width })).toMatchObject({ error: 'invalid_viewport' })
  })

  test('bad arguments fail before any browser launch (no Chromium download on a typo)', async () => {
    // If this ever started launching a browser first, it would hang/download here instead of
    // returning instantly — the ordering (validate, then ensureSessionAndPage) is the point.
    const result = await browserTool({ action: 'resize' }, baseCtx)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('missing_viewport')

    const badPreset = await browserTool({ action: 'resize', preset: 'phone' }, baseCtx)
    expect(badPreset.ok).toBe(false)
    expect(badPreset.error).toBe('unknown_preset')
  })
})

/**
 * Regression tests for the "screenshot came back as a truncated URL" bug.
 *
 * doScreenshot used to return the base64 image on `data.screenshotDataUrl`, but loop.ts lifts
 * exactly `data.dataUrl` out of a tool result into a real ImageBlock. The mismatched key meant
 * the ~90 KB blob stayed inside the JSON payload, hit compactToolResult's 40 000-character hard
 * cut, and reached the model as a data URL chopped mid-base64 — with no image attached.
 */
describe('screenshot result payload contract', () => {
  const fakeImage = 'A'.repeat(120_000) // stand-in for a ~90 KB base64 JPEG

  test('the image rides on `dataUrl` — the exact key loop.ts lifts into an ImageBlock', () => {
    const data = screenshotResultData('abc123', 'https://example.com', { width: 390, height: 844 })
    expect(data.dataUrl).toBe('data:image/jpeg;base64,abc123')
    expect(data.screenshotDataUrl).toBeUndefined()
  })

  test('the viewport is reported so the model knows which layout it is looking at', () => {
    expect(screenshotResultData('x', 'https://example.com', { width: 390, height: 844 }).viewport).toBe('390x844')
    expect(screenshotResultData('x', 'https://example.com', null).viewport).toBeUndefined()
  })

  test('once loop.ts lifts dataUrl, what remains serializes far below the 40k cut (no truncation)', () => {
    const data = screenshotResultData(fakeImage, 'https://example.com', { width: 390, height: 844 })
    // Mirror loop.ts's lifting step.
    delete data.dataUrl
    const json = compactToolResult({ ok: true, summary: 'Screenshot captured', data })
    expect(json).not.toContain('[truncated]')
    expect(json.length).toBeLessThan(500)
  })

  test('the un-lifted payload is exactly what used to overflow — proving the cut was real', () => {
    const json = compactToolResult({
      ok: true,
      summary: 'Screenshot captured',
      data: { screenshotDataUrl: `data:image/jpeg;base64,${fakeImage}`, url: 'https://example.com' }
    })
    expect(json).toContain('[truncated]')
  })
})

describe('summarizeSnapshot', () => {
  const element = (n: number) => ({ ref: `e${n}`, role: 'button', name: `Button ${n}`, tag: 'button' })

  test('renders one ref-tagged line per element, including input values', () => {
    const result = summarizeSnapshot([
      { ref: 'e0', role: 'a', name: 'Home', tag: 'a' },
      { ref: 'e1', role: 'input', name: 'Email', tag: 'input', value: 'a@b.c' }
    ])
    expect(result.tree).toBe('- [e0] a "Home"\n- [e1] input "Email" (value: "a@b.c")')
    expect(result).toMatchObject({ shown: 2, total: 2, truncated: false })
  })

  test('caps the list and announces the omitted count in-band (a silent slice looks like absence)', () => {
    const result = summarizeSnapshot(Array.from({ length: 300 }, (_, i) => element(i)), 250)
    expect(result).toMatchObject({ shown: 250, total: 300, truncated: true })
    expect(result.tree).toContain('50 more interactive element(s) omitted')
    expect(result.tree).toContain('inspect')
    expect(result.tree).not.toContain('[e250]')
  })

  test('a huge page stays well under the 40k tool-result cut, so the JSON is never chopped', () => {
    const elements = Array.from({ length: 5000 }, (_, i) => element(i))
    const snapshot = summarizeSnapshot(elements)
    const json = compactToolResult({
      ok: true,
      summary: `Snapshot: ${snapshot.total} interactive element(s)`,
      data: { url: 'https://example.com', title: 'Huge', elementCount: snapshot.total, tree: snapshot.tree }
    })
    expect(json).not.toContain('[truncated]')
    expect(json.length).toBeLessThan(40_000)
  })
})

describe('browser wait action (plain fixed-duration sleep)', () => {
  const baseCtx = { ownerId: 'test-owner', unattended: false, settings: DEFAULT_BROWSER_AUTOMATION }

  test('waits for roughly the requested duration and reports success', async () => {
    const start = Date.now()
    const result = await browserTool({ action: 'wait', duration_ms: 30 }, baseCtx)
    expect(result.ok).toBe(true)
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
  })

  test('is cancellable via ctx.signal instead of blocking for the full duration', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const promise = browserTool({ action: 'wait', duration_ms: 60_000 }, { ...baseCtx, signal: controller.signal })
    controller.abort()
    const result = await promise
    expect(result.ok).toBe(false)
    expect(result.error).toBe('aborted')
    expect(Date.now() - start).toBeLessThan(5000)
  })

  test('returns immediately if already aborted before the call', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await browserTool({ action: 'wait', duration_ms: 60_000 }, { ...baseCtx, signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('aborted')
  })
})

describe('evaluateNavigation (SSRF / private-network policy)', () => {
  const permissive = { unattended: false, allowPrivateNetwork: true, allowPrivateNetworkUnattended: true }
  const restrictive = { unattended: false, allowPrivateNetwork: false, allowPrivateNetworkUnattended: false }
  const unattendedDefault = { unattended: true, allowPrivateNetwork: true, allowPrivateNetworkUnattended: false }

  test('allows ordinary public https URLs regardless of settings', () => {
    expect(evaluateNavigation('https://example.com', restrictive).allowed).toBe(true)
    expect(evaluateNavigation('https://example.com', permissive).allowed).toBe(true)
  })

  test('always allows about: and data: URLs', () => {
    expect(evaluateNavigation('about:blank', restrictive).allowed).toBe(true)
    expect(evaluateNavigation('data:text/plain,hello', restrictive).allowed).toBe(true)
  })

  test('blocks non-http(s) schemes like file:', () => {
    const decision = evaluateNavigation('file:///etc/passwd', permissive)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/Blocked scheme/)
  })

  test('blocks an invalid URL with a clear reason instead of throwing', () => {
    const decision = evaluateNavigation('not a url', permissive)
    expect(decision.allowed).toBe(false)
  })

  test('cloud metadata endpoint is blocked unconditionally, even with every allow flag on', () => {
    const decision = evaluateNavigation('http://169.254.169.254/latest/meta-data/', {
      unattended: false,
      allowPrivateNetwork: true,
      allowPrivateNetworkUnattended: true
    })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/metadata/)

    const decisionGoogle = evaluateNavigation('http://metadata.google.internal/computeMetadata/v1/', {
      unattended: true,
      allowPrivateNetwork: true,
      allowPrivateNetworkUnattended: true
    })
    expect(decisionGoogle.allowed).toBe(false)
  })

  test('interactive session: private-network URLs allowed only when allowPrivateNetwork is true', () => {
    expect(evaluateNavigation('http://localhost:3000', permissive).allowed).toBe(true)
    expect(evaluateNavigation('http://127.0.0.1:8080', permissive).allowed).toBe(true)
    expect(evaluateNavigation('http://192.168.1.5', permissive).allowed).toBe(true)
    expect(evaluateNavigation('http://10.0.0.5', permissive).allowed).toBe(true)
    expect(evaluateNavigation('http://172.20.0.5', permissive).allowed).toBe(true)

    expect(evaluateNavigation('http://localhost:3000', restrictive).allowed).toBe(false)
  })

  test('unattended session: uses allowPrivateNetworkUnattended, not allowPrivateNetwork', () => {
    // allowPrivateNetwork=true but allowPrivateNetworkUnattended=false (the documented default)
    // must still block private URLs for an unattended run.
    const decision = evaluateNavigation('http://localhost:3000', unattendedDefault)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/unattended/)
  })

  test('unattended session with allowPrivateNetworkUnattended=true is allowed', () => {
    const decision = evaluateNavigation('http://localhost:3000', {
      unattended: true,
      allowPrivateNetwork: false,
      allowPrivateNetworkUnattended: true
    })
    expect(decision.allowed).toBe(true)
  })

  test('link-local (non-metadata) addresses are treated as private, not specially blocked', () => {
    const decision = evaluateNavigation('http://169.254.1.1', restrictive)
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/private\/local/)
  })
})
