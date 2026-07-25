/**
 * Handler for the multiplexed `browser` tool (see definitions.ts for the action-addressed
 * parameter schema exposed to the model). Wraps the Playwright session manager
 * (../../browser/manager.ts) and network policy (../../browser/network-policy.ts) with the
 * per-action logic and the ref-based element-resolution system described in the tool's
 * description string.
 *
 * Element refs: snapshot() injects a stable `data-klenny-ref="eN"` attribute onto every visible
 * interactive element it finds, then returns a readable list tagged with those refs. Every
 * mutating action addresses elements by ref (never a raw CSS selector) so the model doesn't have
 * to reason about page structure — just what it saw in the last snapshot. Refs are scoped to a
 * tab (BrowserSession.refCounters, keyed by tab label) and reset on navigate, since the DOM they
 * refer to is gone at that point.
 */
import type { Page } from 'playwright'
import type { BrowserAutomationSettings, ToolResultPayload } from '@shared/types'
import {
  getOrCreateSession,
  getSession,
  getOrCreatePage,
  closePage,
  listPages,
  disposeSession,
  type BrowserSession
} from '../../browser/manager'
import { evaluateNavigation } from '../../browser/network-policy'

/** Mutating browser actions — gated by BrowserAutomationSettings.policy and, unless 'auto', the
 *  same per-tab approval-mode/acceptAll rules as write_file/run_command (see orchestrator.ts's
 *  executeTool). Kept in sync with agent/shared/types.ts's PendingActionKind doc comment. */
export const MUTATING_BROWSER_ACTIONS = new Set([
  'click',
  'type',
  'fill',
  'select',
  'press_key',
  'scroll',
  'drag',
  'submit',
  'evaluate'
])

export function isBrowserActionMutating(action: string): boolean {
  return MUTATING_BROWSER_ACTIONS.has(action)
}

export interface BrowserToolContext {
  /** Chat tab id (interactive) or subagent/scheduled-task run id (unattended) — the session
   *  manager's ownerId key, so every distinct run/tab gets its own isolated browser session. */
  ownerId: string
  /** True for subagent and scheduled-task runs — forces headless, the stricter private-network
   *  default, and unconditionally forbids 'evaluate' regardless of settings. */
  unattended: boolean
  settings: BrowserAutomationSettings
  /** Surfaces one-time Chromium-download progress (first browser session ever, see
   *  browser/installer.ts) back to the caller, e.g. to reflect it in the UI. */
  onProgress?: (message: string) => void
}

const REF_PATTERN = /^e\d+$/

function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_PATTERN.test(ref)
}

function locatorForRef(page: Page, ref: string) {
  return page.locator(`[data-klenny-ref="${ref}"]`)
}

function networkPolicyOptions(ctx: BrowserToolContext) {
  return {
    unattended: ctx.unattended,
    allowPrivateNetwork: ctx.settings.allowPrivateNetwork,
    allowPrivateNetworkUnattended: ctx.settings.allowPrivateNetworkUnattended
  }
}

/** Resolves (lazily launching if needed) the session + page for this owner/tab. Returns a
 *  ToolResultPayload directly on failure so callers can `if ('ok' in ensured) return ensured`. */
async function ensureSessionAndPage(
  ctx: BrowserToolContext,
  tabLabel: string
): Promise<{ session: BrowserSession; page: Page } | ToolResultPayload> {
  const sessionResult = await getOrCreateSession({
    ownerId: ctx.ownerId,
    // Unattended (subagent/scheduled-task) sessions are always headless, regardless of the
    // headlessForUnattendedRuns setting (see its doc comment in shared/types.ts) — that flag is
    // informational only in v1. Interactive sessions run headed so the user can watch/intervene.
    headless: ctx.unattended,
    networkPolicy: networkPolicyOptions(ctx),
    browserExecutablePath: ctx.settings.browserExecutablePath,
    maxConcurrentSessions: ctx.settings.maxConcurrentSessions,
    onProgress: ctx.onProgress
  })
  if (!sessionResult.ok || !sessionResult.data) {
    return { ok: false, summary: sessionResult.summary, error: sessionResult.error ?? 'session_failed' }
  }
  const pageResult = await getOrCreatePage(sessionResult.data, tabLabel)
  if (!pageResult.ok || !pageResult.data) {
    return { ok: false, summary: pageResult.summary, error: pageResult.error ?? 'page_failed' }
  }
  return { session: sessionResult.data, page: pageResult.data }
}

async function navigateTo(page: Page, url: string, ctx: BrowserToolContext): Promise<ToolResultPayload> {
  const decision = evaluateNavigation(url, networkPolicyOptions(ctx))
  if (!decision.allowed) {
    return { ok: false, summary: 'Navigation blocked by network policy', error: decision.reason ?? 'blocked_by_network_policy' }
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return { ok: true, summary: `Navigated to ${page.url()}`, data: { url: page.url(), title: await page.title() } }
  } catch (e) {
    return { ok: false, summary: 'Navigation failed', error: e instanceof Error ? e.message : String(e) }
  }
}

export async function browserTool(args: Record<string, unknown>, ctx: BrowserToolContext): Promise<ToolResultPayload> {
  const action = String(args.action ?? '')
  const tabLabel = typeof args.tab === 'string' && args.tab ? args.tab : 'main'

  try {
    switch (action) {
      case 'open':
        return await doOpen(args, ctx, tabLabel)
      case 'close':
        return await doClose(args, ctx)
      case 'list_tabs':
        return doListTabs(ctx)
      case 'navigate':
        return await doNavigate(args, ctx, tabLabel)
      case 'snapshot':
        return await doSnapshot(ctx, tabLabel)
      case 'screenshot':
        return await doScreenshot(ctx, tabLabel)
      case 'click':
        return await doClick(args, ctx, tabLabel)
      case 'type':
        return await doType(args, ctx, tabLabel)
      case 'fill':
        return await doFill(args, ctx, tabLabel)
      case 'select':
        return await doSelect(args, ctx, tabLabel)
      case 'press_key':
        return await doPressKey(args, ctx, tabLabel)
      case 'scroll':
        return await doScroll(args, ctx, tabLabel)
      case 'drag':
        return await doDrag(args, ctx, tabLabel)
      case 'submit':
        return await doSubmit(args, ctx, tabLabel)
      case 'evaluate':
        return await doEvaluate(args, ctx, tabLabel)
      case 'wait_for':
        return await doWaitFor(args, ctx, tabLabel)
      default:
        return { ok: false, summary: `Unknown browser action "${action}"`, error: 'unknown_action' }
    }
  } catch (e) {
    return { ok: false, summary: 'Browser action failed', error: e instanceof Error ? e.message : String(e) }
  }
}

async function doOpen(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  const url = typeof args.url === 'string' && args.url ? args.url : undefined
  if (url) return navigateTo(page, url, ctx)
  return { ok: true, summary: `Opened tab "${tabLabel}"`, data: { tab: tabLabel, url: page.url() } }
}

async function doClose(args: Record<string, unknown>, ctx: BrowserToolContext): Promise<ToolResultPayload> {
  const session = getSession(ctx.ownerId)
  if (!session) return { ok: true, summary: 'No active browser session' }
  // Only close the whole session (browser process + all tabs) when no specific tab was named —
  // closing a single named tab should leave the rest of the session (and browser) running.
  const explicitTab = typeof args.tab === 'string' && args.tab ? args.tab : undefined
  if (explicitTab) {
    await closePage(session, explicitTab)
    return { ok: true, summary: `Closed tab "${explicitTab}"` }
  }
  await disposeSession(ctx.ownerId)
  return { ok: true, summary: 'Closed browser session' }
}

function doListTabs(ctx: BrowserToolContext): ToolResultPayload {
  const session = getSession(ctx.ownerId)
  if (!session) return { ok: true, summary: 'No active browser session', data: { tabs: [] } }
  const tabs = listPages(session).map((label) => {
    const page = session.pages.get(label)
    return { tab: label, url: page && !page.isClosed() ? page.url() : '', closed: !page || page.isClosed() }
  })
  return { ok: true, summary: `${tabs.length} tab(s)`, data: { tabs } }
}

async function doNavigate(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const url = typeof args.url === 'string' ? args.url : ''
  if (!url) return { ok: false, summary: 'navigate requires a url', error: 'missing_url' }
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { session, page } = ensured
  // Refs from a prior snapshot point at DOM nodes that no longer exist once we navigate away —
  // reset the counter so the next snapshot starts clean instead of skipping ids or (in a fresh
  // page reusing the same tab label) colliding with elements from the old document.
  session.refCounters.set(tabLabel, 0)
  return navigateTo(page, url, ctx)
}

interface SnapshotElement {
  ref: string
  role: string
  name: string
  tag: string
  value?: string
}

async function doSnapshot(ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { session, page } = ensured

  const startCounter = session.refCounters.get(tabLabel) ?? 0
  const { elements, nextCounter } = await page.evaluate((start: number) => {
    const SELECTOR = [
      'a[href]',
      'button',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="tab"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[contenteditable="true"]',
      '[onclick]',
      'summary'
    ].join(',')

    const isVisible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return false
      const style = window.getComputedStyle(el)
      return style.visibility !== 'hidden' && style.display !== 'none'
    }

    let counter = start
    const results: { ref: string; role: string; name: string; tag: string; value?: string }[] = []
    for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
      if (!(el instanceof HTMLElement)) continue
      if (!isVisible(el)) continue
      if ((el as HTMLInputElement).disabled) continue

      const ref = `e${counter++}`
      el.setAttribute('data-klenny-ref', ref)

      const role = el.getAttribute('role') || el.tagName.toLowerCase()
      const name =
        el.getAttribute('aria-label') ||
        (el as HTMLInputElement).placeholder ||
        el.textContent?.trim().slice(0, 80) ||
        (el as HTMLInputElement).value ||
        ''
      const entry: { ref: string; role: string; name: string; tag: string; value?: string } = {
        ref,
        role,
        name,
        tag: el.tagName.toLowerCase()
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) entry.value = el.value
      results.push(entry)
    }
    return { elements: results, nextCounter: counter }
  }, startCounter)

  session.refCounters.set(tabLabel, nextCounter)

  const tree = (elements as SnapshotElement[])
    .map((e) => `- [${e.ref}] ${e.role} "${e.name}"${e.value ? ` (value: "${e.value}")` : ''}`)
    .join('\n')

  return {
    ok: true,
    summary: `Snapshot: ${elements.length} interactive element(s)`,
    data: { url: page.url(), title: await page.title(), elements, tree }
  }
}

async function doScreenshot(ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60 })
    const screenshotDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
    return {
      ok: true,
      summary: `Screenshot captured (~${Math.round(buf.length / 1024)} KB, roughly ${Math.round(buf.length / 750)} tokens)`,
      data: { screenshotDataUrl, url: page.url() }
    }
  } catch (e) {
    return { ok: false, summary: 'Screenshot failed', error: e instanceof Error ? e.message : String(e) }
  }
}

async function doClick(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  if (!isValidRef(args.ref)) return { ok: false, summary: 'click requires a valid ref from the most recent snapshot', error: 'missing_ref' }
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    await locatorForRef(page, args.ref).click({ timeout: 10_000 })
    return { ok: true, summary: `Clicked ${args.ref}` }
  } catch (e) {
    return {
      ok: false,
      summary: `Click on ${args.ref} failed — the element may be stale; try snapshot again`,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

async function doType(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  if (!isValidRef(args.ref)) return { ok: false, summary: 'type requires a valid ref from the most recent snapshot', error: 'missing_ref' }
  const text = typeof args.text === 'string' ? args.text : ''
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    await locatorForRef(page, args.ref).pressSequentially(text, { timeout: 10_000 })
    return { ok: true, summary: `Typed into ${args.ref}` }
  } catch (e) {
    return { ok: false, summary: `Type into ${args.ref} failed`, error: e instanceof Error ? e.message : String(e) }
  }
}

async function doFill(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  if (!isValidRef(args.ref)) return { ok: false, summary: 'fill requires a valid ref from the most recent snapshot', error: 'missing_ref' }
  const text = typeof args.text === 'string' ? args.text : ''
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    await locatorForRef(page, args.ref).fill(text, { timeout: 10_000 })
    return { ok: true, summary: `Filled ${args.ref}` }
  } catch (e) {
    return { ok: false, summary: `Fill on ${args.ref} failed`, error: e instanceof Error ? e.message : String(e) }
  }
}

async function doSelect(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  if (!isValidRef(args.ref)) return { ok: false, summary: 'select requires a valid ref from the most recent snapshot', error: 'missing_ref' }
  const value = typeof args.value === 'string' ? args.value : ''
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    await locatorForRef(page, args.ref).selectOption(value, { timeout: 10_000 })
    return { ok: true, summary: `Selected "${value}" on ${args.ref}` }
  } catch (e) {
    return { ok: false, summary: `Select on ${args.ref} failed`, error: e instanceof Error ? e.message : String(e) }
  }
}

async function doPressKey(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const key = typeof args.key === 'string' && args.key ? args.key : 'Enter'
  const hasRef = args.ref !== undefined
  if (hasRef && !isValidRef(args.ref)) return { ok: false, summary: 'Invalid ref', error: 'invalid_ref' }
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    if (hasRef) await locatorForRef(page, args.ref as string).press(key, { timeout: 10_000 })
    else await page.keyboard.press(key)
    return { ok: true, summary: `Pressed "${key}"${hasRef ? ` on ${args.ref}` : ''}` }
  } catch (e) {
    return { ok: false, summary: `Press "${key}" failed`, error: e instanceof Error ? e.message : String(e) }
  }
}

async function doScroll(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const hasRef = args.ref !== undefined
  if (hasRef && !isValidRef(args.ref)) return { ok: false, summary: 'Invalid ref', error: 'invalid_ref' }
  const dx = typeof args.dx === 'number' ? args.dx : 0
  const dy = typeof args.dy === 'number' ? args.dy : 0
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    if (hasRef) {
      await locatorForRef(page, args.ref as string).scrollIntoViewIfNeeded({ timeout: 10_000 })
      return { ok: true, summary: `Scrolled ${args.ref} into view` }
    }
    await page.mouse.wheel(dx, dy)
    return { ok: true, summary: `Scrolled by (${dx}, ${dy})` }
  } catch (e) {
    return { ok: false, summary: 'Scroll failed', error: e instanceof Error ? e.message : String(e) }
  }
}

async function doDrag(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  if (!isValidRef(args.ref) || !isValidRef(args.targetRef)) {
    return { ok: false, summary: 'drag requires ref and targetRef, both from the most recent snapshot', error: 'missing_ref' }
  }
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    await locatorForRef(page, args.ref).dragTo(locatorForRef(page, args.targetRef), { timeout: 10_000 })
    return { ok: true, summary: `Dragged ${args.ref} to ${args.targetRef}` }
  } catch (e) {
    return { ok: false, summary: 'Drag failed', error: e instanceof Error ? e.message : String(e) }
  }
}

async function doSubmit(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  if (!isValidRef(args.ref)) return { ok: false, summary: 'submit requires a valid ref (a form field or button) from the most recent snapshot', error: 'missing_ref' }
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    const text = typeof args.text === 'string' ? args.text : undefined
    const loc = locatorForRef(page, args.ref)
    if (text !== undefined) await loc.fill(text, { timeout: 10_000 })
    await loc.evaluate((el: Element) => {
      const form = (el as HTMLInputElement).form ?? el.closest('form')
      if (form) form.requestSubmit()
      else if (el instanceof HTMLElement) el.click()
    })
    return { ok: true, summary: `Submitted form via ${args.ref}` }
  } catch (e) {
    return { ok: false, summary: 'Submit failed', error: e instanceof Error ? e.message : String(e) }
  }
}

async function doEvaluate(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  // Defense in depth: enforced here as well as by omission from every subagent/scheduled-task
  // tool allowlist, so a misconfigured allowlist can never grant arbitrary JS execution to an
  // unattended run.
  if (ctx.unattended) {
    return { ok: false, summary: 'evaluate is never available to subagents or scheduled tasks', error: 'evaluate_forbidden_unattended' }
  }
  if (!ctx.settings.allowEvaluate) {
    return {
      ok: false,
      summary: 'JavaScript evaluation is disabled — enable "Allow JavaScript evaluation" in Settings \u2192 Automation \u2192 Browser automation',
      error: 'evaluate_disabled'
    }
  }
  const code = typeof args.code === 'string' ? args.code : ''
  if (!code) return { ok: false, summary: 'evaluate requires code', error: 'missing_code' }
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    const result = await page.evaluate(code)
    return { ok: true, summary: 'Evaluated JavaScript', data: { result } }
  } catch (e) {
    return { ok: false, summary: 'Evaluate failed', error: e instanceof Error ? e.message : String(e) }
  }
}

async function doWaitFor(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const timeout = typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : 5000
  const hasRef = args.ref !== undefined
  if (hasRef && !isValidRef(args.ref)) return { ok: false, summary: 'Invalid ref', error: 'invalid_ref' }
  const selector = typeof args.selector === 'string' && args.selector ? args.selector : undefined
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { page } = ensured
  try {
    if (hasRef) await locatorForRef(page, args.ref as string).waitFor({ timeout, state: 'visible' })
    else if (selector) await page.waitForSelector(selector, { timeout, state: 'visible' })
    else await page.waitForLoadState('domcontentloaded', { timeout })
    return { ok: true, summary: 'Wait condition met' }
  } catch (e) {
    return { ok: false, summary: 'Wait timed out', error: e instanceof Error ? e.message : String(e) }
  }
}

/** Builds the human-readable title + best-effort screenshot preview for a browser_act approval
 *  card (policy='ask'). Only screenshots an already-open page — never launches one just to
 *  preview an action — matching PendingAction.screenshotDataUrl's doc comment. */
export async function buildBrowserApprovalPreview(
  args: Record<string, unknown>,
  ctx: BrowserToolContext
): Promise<{ title: string; screenshotDataUrl?: string }> {
  const action = String(args.action ?? 'browser action')
  const ref = typeof args.ref === 'string' ? args.ref : undefined
  const titles: Record<string, string> = {
    click: `Click ${ref ?? ''}`.trim(),
    type: `Type "${String(args.text ?? '')}" into ${ref ?? ''}`.trim(),
    fill: `Fill ${ref ?? ''} with "${String(args.text ?? '')}"`.trim(),
    select: `Select "${String(args.value ?? '')}" on ${ref ?? ''}`.trim(),
    press_key: `Press "${String(args.key ?? 'Enter')}"${ref ? ` on ${ref}` : ''}`,
    scroll: `Scroll${ref ? ` ${ref} into view` : ''}`,
    drag: `Drag ${ref ?? ''} to ${String(args.targetRef ?? '')}`,
    submit: `Submit form via ${ref ?? ''}`,
    evaluate: 'Run JavaScript in the page'
  }
  const title = titles[action] ?? `Browser: ${action}`

  let screenshotDataUrl: string | undefined
  try {
    const session = getSession(ctx.ownerId)
    const tabLabel = typeof args.tab === 'string' && args.tab ? args.tab : 'main'
    const page = session?.pages.get(tabLabel)
    if (page && !page.isClosed()) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 50 })
      screenshotDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
    }
  } catch {
    // Best-effort preview only — the approval still proceeds without a screenshot if this fails.
  }

  return { title, screenshotDataUrl }
}
