import { describe, expect, test } from 'bun:test'
import { evaluateNavigation } from '../src/main/browser/network-policy'
import { isBrowserActionMutating, MUTATING_BROWSER_ACTIONS, browserTool } from '../src/main/agent/tools/browser'
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
  test('agent mode includes the browser tool', () => {
    const tools = getToolDefinitions('agent').map((t) => t.function.name)
    expect(tools).toContain('browser')
  })

  test('plan mode excludes the browser tool (mutating-capable, agent-mode only)', () => {
    const tools = getToolDefinitions('plan').map((t) => t.function.name)
    expect(tools).not.toContain('browser')
  })

  test('browser tool is available with no workspace open (Assistant tab) since it needs no file I/O', () => {
    const tools = getToolDefinitions('agent', 'all', false, false).map((t) => t.function.name)
    expect(tools).toContain('browser')
  })

  test('restrictTo can exclude browser for a restricted subagent type', () => {
    const tools = getToolDefinitions('agent', ['read_file', 'grep']).map((t) => t.function.name)
    expect(tools).not.toContain('browser')
  })

  test("restrictTo 'all' keeps browser available", () => {
    const tools = getToolDefinitions('agent', 'all').map((t) => t.function.name)
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

  test('classifies open/close/list_tabs/navigate/snapshot/screenshot/wait_for/wait as non-mutating (always allowed unless policy=off)', () => {
    for (const action of ['open', 'close', 'list_tabs', 'navigate', 'snapshot', 'screenshot', 'wait_for', 'wait']) {
      expect(isBrowserActionMutating(action)).toBe(false)
    }
  })

  test('unknown actions are treated as non-mutating (fail via the unknown_action branch, not gated as mutating)', () => {
    expect(isBrowserActionMutating('teleport')).toBe(false)
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
