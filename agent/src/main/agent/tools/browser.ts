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

/** Static, best-effort rejection list for `inspect` (read-only JS evaluation) — checked against
 *  the raw code string *before* it ever reaches the page, purely so obviously-mutating code fails
 *  fast with a clear message instead of relying only on the runtime guards in `inspectInPage`.
 *  Not a security boundary by itself (a determined obfuscator can dodge regexes) — see the
 *  runtime containment in `inspectInPage` for the actual defense-in-depth layer, and the
 *  `browser-automation` skill's "Known limitations" section for what neither layer catches. */
export const INSPECT_DENY_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bfetch\s*\(/, label: 'fetch(' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bWebSocket\b/, label: 'WebSocket' },
  { pattern: /\bEventSource\b/, label: 'EventSource' },
  { pattern: /sendBeacon/, label: 'navigator.sendBeacon' },
  { pattern: /\.(setItem|removeItem|clear)\s*\(/, label: 'storage mutation (.setItem/.removeItem/.clear)' },
  { pattern: /document\.cookie\s*=/, label: 'document.cookie =' },
  { pattern: /\bindexedDB\b/, label: 'indexedDB' },
  { pattern: /history\.(pushState|replaceState|go|back|forward)\s*\(/, label: 'history navigation' },
  { pattern: /\blocation\s*(\.\w+\s*=(?!=)|=(?!=)|\.\s*(assign|replace|reload)\s*\()/, label: 'location navigation' },
  { pattern: /window\.open\s*\(/, label: 'window.open(' },
  { pattern: /\.postMessage\s*\(/, label: 'postMessage' },
  {
    pattern:
      /\.(appendChild|insertBefore|removeChild|replaceChild|append|prepend|before|after|replaceWith|insertAdjacentHTML|insertAdjacentElement|insertAdjacentText|setAttribute|removeAttribute|toggleAttribute)\s*\(/,
    label: 'DOM mutation method'
  },
  {
    // Every alternative needs its own (?!=) so an `===`/`==` *comparison* isn't mistaken for an
    // assignment. Comparing text content is bread-and-butter read-only inspection
    // (`el.textContent === 'Example Domain'`), and without the lookahead the first `=` of `===`
    // matched and the call was rejected outright. The `.value` pattern below always had it — these
    // four were a plain oversight, not a deliberate choice.
    pattern: /\.innerHTML\s*=(?!=)|\.outerHTML\s*=(?!=)|\.textContent\s*=(?!=)|\.innerText\s*=(?!=)/,
    label: 'DOM content assignment'
  },
  { pattern: /\.value\s*=(?!=)/, label: 'form value assignment' },
  { pattern: /\.click\s*\(/, label: '.click(' },
  { pattern: /\.(submit|requestSubmit)\s*\(/, label: 'form submit' },
  { pattern: /dispatchEvent\s*\(/, label: 'dispatchEvent' },
  { pattern: /document\.(write|writeln|execCommand)\s*\(/, label: 'document.write/execCommand' },
  { pattern: /\bnew\s+(Worker|SharedWorker)\b/, label: 'Worker/SharedWorker' },
  { pattern: /\beval\s*\(/, label: 'eval(' },
  { pattern: /\bnew\s+Function\s*\(/, label: 'new Function(' },
  { pattern: /\.constructor\s*\(/, label: '.constructor(' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import(' },
  { pattern: /\bReflect\b|\bProxy\b/, label: 'Reflect/Proxy' },
  { pattern: /\.style\.(setProperty|removeProperty|cssText)\b/, label: 'inline style mutation' }
]

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
  /** Turn/run abort signal, used by the `wait` action so a long pause can be cut short
   *  immediately if the user stops the run, instead of blocking until its full duration. */
  signal?: AbortSignal
}

/** Hard ceiling for the `wait` action's duration_ms, so a bad/huge value from the model can't
 *  block a turn indefinitely. Generous enough for "wait a couple of minutes for a page to
 *  finish something" while still bounded. */
const MAX_WAIT_MS = 5 * 60_000

const REF_PATTERN = /^e\d+$/

function isValidRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_PATTERN.test(ref)
}

function locatorForRef(page: Page, ref: string) {
  return page.locator(`[data-klenny-ref="${ref}"]`)
}

/** Serializes per-tab ref *minting* — the read→evaluate→commit sequence in doSnapshot/doInspect.
 *
 *  Without this, both did a read-modify-write straddling an `await`: concurrent calls on the same
 *  tab all read the same starting counter, handed out **overlapping ref numbers**, and whichever
 *  resolved last won the write — which could also roll the counter *backward* and corrupt later
 *  sequential calls. Two elements sharing a ref means `locatorForRef`'s `[data-klenny-ref="eN"]`
 *  matches both: a Playwright strict-mode violation, or silently acting on the wrong element.
 *  Refs are this tool's entire addressing model, and the race was easy to hit precisely because
 *  the system prompt encourages firing independent tool calls in parallel. `snapshot` and
 *  `inspect` share one counter, so a parallel inspect+snapshot raced too.
 *
 *  Keyed by session *and* tab label, so independent tabs never queue behind each other. The
 *  WeakMap lets a disposed session's locks be collected; a resolved per-label entry in a live
 *  session is inert. */
const refLocks = new WeakMap<BrowserSession, Map<string, Promise<void>>>()

export async function withRefLock<T>(session: BrowserSession, tabLabel: string, fn: () => Promise<T>): Promise<T> {
  let perTab = refLocks.get(session)
  if (!perTab) {
    perTab = new Map()
    refLocks.set(session, perTab)
  }
  const previous = perTab.get(tabLabel) ?? Promise.resolve()
  const result = previous.then(fn)
  // Store an outcome-swallowing view of this call: one failing inspect must not reject everything
  // queued behind it. The caller above still receives its own real result or error via `result`.
  perTab.set(
    tabLabel,
    result.then(
      () => undefined,
      () => undefined
    )
  )
  return result
}

/** Advances a tab's ref counter, never letting it regress — belt-and-braces alongside withRefLock,
 *  so that even if some future path escapes the lock, a late-completing call can't roll the counter
 *  back and cause the next mint to re-issue numbers already attached to elements in the page. The
 *  deliberate exception is `navigate`, which resets to 0 on purpose (the old document's elements
 *  are gone, so its refs are meaningless and numbering should start clean). */
export function commitRefCounter(session: BrowserSession, tabLabel: string, nextCounter: number): void {
  const existing = session.refCounters.get(tabLabel) ?? 0
  session.refCounters.set(tabLabel, Math.max(existing, nextCounter))
}

/** Best-effort resync of a tab's ref counter from the refs actually present in the DOM, used only
 *  on inspect's failure path. A timed-out `page.evaluate` keeps running inside the page and may
 *  mint refs whose count never made it back to us, so without this the next mint could re-issue a
 *  number that's already on a live element — exactly the duplicate-ref failure withRefLock exists
 *  to prevent. Must be called while holding the lock. */
async function recoverRefCounterFromDom(session: BrowserSession, page: Page, tabLabel: string): Promise<void> {
  try {
    const highest = await page.evaluate(() => {
      let max = -1
      for (const el of Array.from(document.querySelectorAll('[data-klenny-ref]'))) {
        const matched = /^e(\d+)$/.exec(el.getAttribute('data-klenny-ref') ?? '')
        if (matched) max = Math.max(max, Number(matched[1]))
      }
      return max
    })
    if (highest >= 0) commitRefCounter(session, tabLabel, highest + 1)
  } catch {
    // Page closed/navigated out from under us — nothing better available, and commitRefCounter's
    // monotonicity still prevents regressing below what we already know about.
  }
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
      case 'inspect':
        return await doInspect(args, ctx, tabLabel)
      case 'wait_for':
        return await doWaitFor(args, ctx, tabLabel)
      case 'wait':
        return await doWait(args, ctx)
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

/** Runs inside the page (via page.evaluate, see doSnapshot). Tags every visible, enabled
 *  interactive element with a `data-klenny-ref` numbered from `start`, returning them plus the
 *  counter's new value. Extracted to module scope — like inspectInPage — so doSnapshot's
 *  ref-counter locking stays readable instead of wrapping 50 indented lines. */
function snapshotInPage(start: number): { elements: SnapshotElement[]; nextCounter: number } {
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
  const results: SnapshotElement[] = []
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
    const entry: SnapshotElement = {
      ref,
      role,
      name,
      tag: el.tagName.toLowerCase()
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) entry.value = el.value
    results.push(entry)
  }
  return { elements: results, nextCounter: counter }
}

async function doSnapshot(ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { session, page } = ensured

  // Read→evaluate→commit has to be atomic per tab, or a parallel snapshot/inspect on the same tab
  // mints colliding refs (see withRefLock).
  const { elements } = await withRefLock(session, tabLabel, async () => {
    const startCounter = session.refCounters.get(tabLabel) ?? 0
    const outcome = await page.evaluate(snapshotInPage, startCounter)
    commitRefCounter(session, tabLabel, outcome.nextCounter)
    return outcome
  })

  const tree = elements.map((e) => `- [${e.ref}] ${e.role} "${e.name}"${e.value ? ` (value: "${e.value}")` : ''}`).join('\n')

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

/** Ceiling for `inspect`'s execution, independent of MAX_WAIT_MS — this runs synchronously
 *  during a tool call rather than something the model is deliberately waiting on, so it gets a
 *  much shorter leash. Enforced on the Node side via Promise.race since page.evaluate() itself
 *  has no timeout option — a hung/looping snippet otherwise blocks the page indefinitely. */
const INSPECT_TIMEOUT_MS = 15_000

/** Runs entirely inside the page (via page.evaluate) — installs best-effort read-only guards,
 *  executes the model's code through an AsyncFunction so `await` works, then restores every
 *  patched API before returning. This is defense in depth, not a security boundary: it raises
 *  the bar against both accidental and injected mutation attempts, but a sufficiently determined
 *  adversarial page could still find gaps (see the browser-automation skill's "Known
 *  limitations"). Takes `start` (the current ref counter, so `klenny.ref()` continues the same
 *  numbering snapshot() uses) and the code string; returns the value, or an error string, plus
 *  the counter's new value after any klenny.ref() calls. */
export async function inspectInPage(args: {
  code: string
  start: number
}): Promise<{ ok: boolean; result?: unknown; error?: string; nextCounter: number }> {
  const win = window as unknown as Record<string, unknown>
  let counter = args.start
  const restores: (() => void)[] = []

  // Captured *before* any guard below is installed, so the element→ref bridge stays structurally
  // immune to them. `ref()` tags elements with `setAttribute`, which is itself one of the blocked
  // DOM-mutation methods, and `autoRef()` runs inside the same try block that the guards are only
  // restored *after* — so without these raw references, any inspect call returning an untagged
  // element would trip its own guard and fail with the DOM-mutation message. Do NOT "fix" that by
  // dropping setAttribute from the guard list: model code must still be blocked from calling it.
  const elementProtoForRef = (win.Element as { prototype: Element } | undefined)?.prototype
  const rawGetAttribute = elementProtoForRef?.getAttribute as ((this: Element, name: string) => string | null) | undefined
  const rawSetAttribute = elementProtoForRef?.setAttribute as ((this: Element, name: string, value: string) => void) | undefined

  // The *entire* body is guarded, not just the assignment: merely reading `obj[key]` can throw on
  // some origins (a getter that rejects, e.g. `localStorage` on a `data:` URL, which Chromium
  // refuses with a SecurityError). An unguarded read there used to abort the whole inspect before
  // the model's code ever ran, so failing soft per-API is the correct behavior for this layer.
  function block(obj: unknown, key: string, message: string): void {
    try {
      const target = obj as Record<string, unknown>
      if (!target || !(key in target)) return
      const original = target[key]
      target[key] = function () {
        throw new Error(message)
      }
      restores.push(() => {
        try {
          target[key] = original
        } catch {
          // best-effort
        }
      })
    } catch {
      // Unreadable or non-reassignable property (non-configurable in some engines, or a throwing
      // getter) — best-effort only, matching this whole layer's defense-in-depth nature.
    }
  }

  function blockSetter(proto: unknown, key: string, message: string): void {
    try {
      const target = proto as object
      if (!target) return
      const desc = Object.getOwnPropertyDescriptor(target, key)
      if (!desc || !desc.get) return
      Object.defineProperty(target, key, {
        get: desc.get,
        set: () => {
          throw new Error(message)
        },
        configurable: true
      })
      restores.push(() => {
        try {
          Object.defineProperty(target, key, desc)
        } catch {
          // best-effort
        }
      })
    } catch {
      // best-effort (see block() above for why the whole body is guarded)
    }
  }

  const denyMsg = (what: string) => `inspect is read-only — ${what} is blocked. Use the other browser actions (click/fill/etc.) to change the page instead.`

  // Network
  block(win, 'fetch', denyMsg('fetch()'))
  block((win.XMLHttpRequest as { prototype: unknown })?.prototype, 'open', denyMsg('XMLHttpRequest'))
  block(win, 'WebSocket', denyMsg('WebSocket'))
  block(win, 'EventSource', denyMsg('EventSource'))
  const nav = win.navigator as Record<string, unknown> | undefined
  if (nav) block(nav, 'sendBeacon', denyMsg('navigator.sendBeacon'))

  // Storage. Reading these properties *at all* throws on opaque origins — Chromium rejects
  // `localStorage` on a `data:` URL with "SecurityError: Storage is disabled inside 'data:' URLs",
  // which used to abort the entire inspect before any model code ran (ruling out `data:` URLs as a
  // zero-dependency scratchpad). Read each one defensively and simply skip what isn't there.
  const storages: Storage[] = []
  for (const storageKey of ['localStorage', 'sessionStorage']) {
    try {
      const candidate = win[storageKey]
      if (candidate) storages.push(candidate as Storage)
    } catch {
      // Storage unavailable on this origin (data:, sandboxed iframe, blocked cookies) — there's
      // nothing to harden, and the block() calls below would be no-ops anyway.
    }
  }
  for (const s of storages) {
    block(s, 'setItem', denyMsg('storage writes'))
    block(s, 'removeItem', denyMsg('storage writes'))
    block(s, 'clear', denyMsg('storage writes'))
  }
  block(win, 'indexedDB', denyMsg('indexedDB'))
  blockSetter((win.Document as { prototype: unknown })?.prototype, 'cookie', denyMsg('document.cookie ='))

  // Navigation
  const historyProto = (win.History as { prototype: unknown })?.prototype
  block(historyProto, 'pushState', denyMsg('history navigation'))
  block(historyProto, 'replaceState', denyMsg('history navigation'))
  block(historyProto, 'go', denyMsg('history navigation'))
  block(historyProto, 'back', denyMsg('history navigation'))
  block(historyProto, 'forward', denyMsg('history navigation'))
  const locationProto = (win.Location as { prototype: unknown })?.prototype
  block(locationProto, 'assign', denyMsg('location navigation'))
  block(locationProto, 'replace', denyMsg('location navigation'))
  block(locationProto, 'reload', denyMsg('location navigation'))
  block(win, 'open', denyMsg('window.open'))
  block(win, 'close', denyMsg('window.close'))

  // DOM mutation
  const nodeProto = (win.Node as { prototype: unknown })?.prototype
  for (const m of ['appendChild', 'insertBefore', 'removeChild', 'replaceChild']) block(nodeProto, m, denyMsg('DOM mutation'))
  const elProto = (win.Element as { prototype: unknown })?.prototype
  for (const m of [
    'append',
    'prepend',
    'before',
    'after',
    'replaceWith',
    'remove',
    'setAttribute',
    'removeAttribute',
    'toggleAttribute',
    'insertAdjacentHTML',
    'insertAdjacentElement',
    'insertAdjacentText'
  ])
    block(elProto, m, denyMsg('DOM mutation'))
  blockSetter(elProto, 'innerHTML', denyMsg('innerHTML ='))
  blockSetter(elProto, 'outerHTML', denyMsg('outerHTML ='))
  blockSetter(nodeProto, 'textContent', denyMsg('textContent ='))
  const htmlElProto = (win.HTMLElement as { prototype: unknown })?.prototype
  block(htmlElProto, 'click', denyMsg('.click()'))
  const formProto = (win.HTMLFormElement as { prototype: unknown })?.prototype
  block(formProto, 'submit', denyMsg('form.submit()'))
  block(formProto, 'requestSubmit', denyMsg('form.requestSubmit()'))
  for (const ctor of ['HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']) {
    const proto = (win[ctor] as { prototype: unknown })?.prototype
    blockSetter(proto, 'value', denyMsg('.value ='))
  }

  // Misc escape hatches
  block(win, 'postMessage', denyMsg('postMessage'))
  const evtProto = (win.EventTarget as { prototype: unknown })?.prototype
  block(evtProto, 'dispatchEvent', denyMsg('dispatchEvent'))
  const docObj = win.document as Record<string, unknown>
  if (docObj) {
    block(docObj, 'write', denyMsg('document.write'))
    block(docObj, 'writeln', denyMsg('document.write'))
    block(docObj, 'execCommand', denyMsg('document.execCommand'))
  }
  block(win, 'Worker', denyMsg('Worker'))
  block(win, 'SharedWorker', denyMsg('SharedWorker'))
  block(win, 'eval', denyMsg('eval()'))
  block(win, 'Function', denyMsg('new Function()'))

  // Bridges a DOM element to a stable ref (tagging it exactly like snapshot() does) so the model
  // can hand it to click/fill/etc. afterward instead of trying to act on it via more JS.
  function ref(el: unknown): string | null {
    if (!(el instanceof Element)) return null
    // Raw (pre-guard) accessors — see the capture site above for why these can't go through the
    // patched prototype methods. The fallbacks only matter in exotic environments where
    // Element.prototype wasn't readable at capture time.
    const tag = rawGetAttribute ? rawGetAttribute.call(el, 'data-klenny-ref') : el.getAttribute('data-klenny-ref')
    if (tag) return tag
    const id = `e${counter++}`
    if (rawSetAttribute) rawSetAttribute.call(el, 'data-klenny-ref', id)
    else el.setAttribute('data-klenny-ref', id)
    return id
  }

  /** Depth ceiling for autoRef's recursion — deep enough for any realistic shape a model returns,
   *  shallow enough that a pathological structure can't blow the stack inside page.evaluate. */
  const AUTO_REF_MAX_DEPTH = 8

  function isPlainObject(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  }

  // Converts every Element *anywhere* in the returned value into a ref. Recursing into plain
  // objects matters because `{label: el}` grouping is a natural thing for a model to return, and
  // without it the element fell through to Playwright's serializer as the useless, deceptively
  // ref-looking string "ref: <Node>" — a silent wrong answer rather than an error. A NodeList
  // nested inside an object degraded the same way, since only the top level was ever checked.
  // Only plain objects are traversed: class instances are left alone so we don't walk something
  // with side-effecting getters.
  function autoRef(value: unknown, depth = 0, path: Set<object> = new Set()): unknown {
    if (value instanceof Element) return ref(value)
    if (depth >= AUTO_REF_MAX_DEPTH) return value
    const isList = value instanceof NodeList || value instanceof HTMLCollection
    if (!isList && !Array.isArray(value) && !isPlainObject(value)) return value
    // `path` tracks the current branch only (added before recursing, removed after), so a genuine
    // cycle is caught while a DAG — the same element referenced twice, e.g. `[el, el]` — still
    // resolves to the same ref in both slots instead of being misreported as circular.
    const asObject = value as object
    if (path.has(asObject)) return '[circular]'
    path.add(asObject)
    try {
      if (isList) return Array.from(value as NodeList | HTMLCollection).map((v) => autoRef(v, depth + 1, path))
      if (Array.isArray(value)) return value.map((v) => autoRef(v, depth + 1, path))
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = autoRef(v, depth + 1, path)
      return out
    } finally {
      path.delete(asObject)
    }
  }

  const klenny = { ref }

  try {
    // AsyncFunction constructor grabbed before `Function` above is patched — patching happens on
    // `window.Function`, this local reference is unaffected. Lets the model's code use `await`.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (k: typeof klenny) => Promise<unknown>
    let run: (k: typeof klenny) => Promise<unknown>
    try {
      // Prefer treating the code as a single expression so `document.title` style snippets
      // (matching how `evaluate` behaves today) don't need an explicit `return`.
      run = new AsyncFunction('klenny', `return (\n${args.code}\n)`)
    } catch {
      run = new AsyncFunction('klenny', args.code)
    }
    const result = await run(klenny)
    return { ok: true, result: autoRef(result), nextCounter: counter }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), nextCounter: counter }
  } finally {
    for (const restore of restores.reverse()) restore()
  }
}

async function doInspect(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const code = typeof args.code === 'string' ? args.code : ''
  if (!code) return { ok: false, summary: 'inspect requires code', error: 'missing_code' }

  for (const { pattern, label } of INSPECT_DENY_PATTERNS) {
    if (pattern.test(code)) {
      return {
        ok: false,
        summary: `inspect is read-only and rejected this code because it looks like it tries to mutate the page (${label}). Use click/type/fill/select/etc. — or evaluate, if enabled — for that instead.`,
        error: 'inspect_denied_pattern'
      }
    }
  }

  const ensured = await ensureSessionAndPage(ctx, tabLabel)
  if ('ok' in ensured) return ensured
  const { session, page } = ensured

  // Read→evaluate→commit has to be atomic per tab: concurrent inspects otherwise all start from
  // the same counter and mint colliding refs (see withRefLock).
  return withRefLock(session, tabLabel, async () => {
    const startCounter = session.refCounters.get(tabLabel) ?? 0
    try {
      const outcome = await Promise.race([
        page.evaluate(inspectInPage, { code, start: startCounter }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('inspect timed out (15s) — likely an infinite loop or unresolved await')), INSPECT_TIMEOUT_MS))
      ])
      commitRefCounter(session, tabLabel, outcome.nextCounter)
      if (!outcome.ok) {
        return { ok: false, summary: 'Inspect failed', error: outcome.error ?? 'inspect_failed' }
      }
      return { ok: true, summary: 'Inspected page (read-only)', data: { result: outcome.result } }
    } catch (e) {
      // A timeout rejects the race but leaves the in-page code running, so it may have minted refs
      // whose count never came back. Resync from the DOM so the next mint can't reuse a live ref.
      await recoverRefCounterFromDom(session, page, tabLabel)
      return { ok: false, summary: 'Inspect failed', error: e instanceof Error ? e.message : String(e) }
    }
  })
}

async function doWaitFor(args: Record<string, unknown>, ctx: BrowserToolContext, tabLabel: string): Promise<ToolResultPayload> {
  const requested = typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : 5000
  const timeout = Math.min(requested, MAX_WAIT_MS)
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

/** Plain sleep — unlike `wait_for` (which polls for a selector/ref/load-state and returns as soon
 *  as its condition is met), `wait` just pauses for a fixed duration. Useful when something is
 *  processing server-side with no visible DOM change to poll for (e.g. "wait a couple of minutes
 *  for this render/export job to finish") and there's nothing better to wait on. Doesn't require
 *  an open session/page since it doesn't touch the page at all. Cancellable via ctx.signal so
 *  stopping the run doesn't leave it blocking for the full duration. */
async function doWait(args: Record<string, unknown>, ctx: BrowserToolContext): Promise<ToolResultPayload> {
  const requested = typeof args.duration_ms === 'number' && args.duration_ms > 0 ? args.duration_ms : 5000
  const duration = Math.min(requested, MAX_WAIT_MS)
  if (ctx.signal?.aborted) return { ok: false, summary: 'Wait cancelled', error: 'aborted' }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      ctx.signal?.removeEventListener('abort', onAbort)
      resolve()
    }, duration)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
  })

  if (ctx.signal?.aborted) return { ok: false, summary: 'Wait cancelled', error: 'aborted' }
  return { ok: true, summary: `Waited ${Math.round(duration / 1000)}s` }
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
