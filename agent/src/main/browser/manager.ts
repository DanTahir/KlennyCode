/**
 * Manages persistent Playwright browser sessions keyed by chat tab ID (interactive) or
 * subagent run ID (unattended). Mirrors the terminal.ts persistent-resource pattern.
 *
 * Lifecycle:
 *  - Lazy launch: first browser tool call for a given owner launches a session.
 *  - Tab close: disposeSession() is hooked into clearTabState() in ipc.ts.
 *  - App quit: disposeAllSessions() is called from the before-quit handler in index.ts.
 *  - Subagent runs: ephemeral sessions are created and disposed in the subagent's finally block.
 *  - Concurrency cap: prevents unbounded Chromium process spawning.
 *  - Crash handling: if browser.on('disconnected') fires unexpectedly, remove from the map
 *    so the next tool call re-launches cleanly rather than operating on a dead handle.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { evaluateNavigation, type NetworkPolicyOptions } from './network-policy'
import { ensureChromiumInstalled, type InstallProgressCallback } from './installer'

export interface BrowserSession {
  ownerId: string // tab id or subagent run id
  browser: Browser
  context: BrowserContext
  pages: Map<string, Page> // agent-controlled tab label -> Page
  headless: boolean
  networkPolicy: NetworkPolicyOptions
  /** monotonically increasing counter used to assign stable data-klenny-ref="eN" labels
   *  each time a snapshot is taken (see tools/browser.ts). Reset per page, not per session. */
  refCounters: Map<string, number>
  createdAt: number
}

export interface ManagerResult<T> {
  ok: boolean
  summary: string
  error?: string
  data?: T
}

const sessions = new Map<string, BrowserSession>()
let activeCount = 0

/**
 * Retrieve or create a session for a given owner (tab or subagent run). If a session already
 * exists, returns it immediately. Otherwise, launches a new one (subject to concurrency cap).
 */
export async function getOrCreateSession(opts: {
  ownerId: string
  headless: boolean
  networkPolicy: NetworkPolicyOptions
  browserExecutablePath?: string | null
  maxConcurrentSessions: number
  /** Surfaces one-time Chromium-download progress (see installer.ts) back to the caller, e.g.
   *  to reflect it in the UI via a `tool_call_progress` stream event. */
  onProgress?: InstallProgressCallback
}): Promise<ManagerResult<BrowserSession>> {
  const existing = sessions.get(opts.ownerId)
  if (existing) return { ok: true, summary: 'Reused existing browser session', data: existing }

  if (activeCount >= opts.maxConcurrentSessions) {
    return {
      ok: false,
      summary: `Browser automation concurrency limit (${opts.maxConcurrentSessions} max concurrent sessions) reached. Close a browser session first.`,
      error: 'concurrency_exceeded'
    }
  }

  // Only Playwright's own bundled Chromium needs the lazy first-run download below — a custom
  // browserExecutablePath means the user is pointing at an already-installed Chrome/Edge/Brave.
  if (!opts.browserExecutablePath) {
    try {
      await ensureChromiumInstalled(opts.onProgress)
    } catch (e) {
      return {
        ok: false,
        summary: 'Failed to download Chromium for browser automation. Try again, or set a custom browser executable path in Settings \u2192 Automation \u2192 Browser automation.',
        error: e instanceof Error ? e.message : String(e)
      }
    }
  }

  activeCount++
  try {
    const browser = await chromium.launch({
      headless: opts.headless,
      executablePath: opts.browserExecutablePath || undefined
    })
    const context = await browser.newContext()

    context.on('page', (page) => {
      page.route('**/*', async (route) => {
        const decision = evaluateNavigation(route.request().url(), opts.networkPolicy)
        if (decision.allowed) await route.continue()
        else await route.abort('blockedbynetwork')
      })
    })

    const session: BrowserSession = {
      ownerId: opts.ownerId,
      browser,
      context,
      pages: new Map(),
      headless: opts.headless,
      networkPolicy: opts.networkPolicy,
      refCounters: new Map(),
      createdAt: Date.now()
    }

    browser.on('disconnected', () => {
      sessions.delete(opts.ownerId)
      activeCount = Math.max(0, activeCount - 1)
    })

    sessions.set(opts.ownerId, session)
    return { ok: true, summary: 'Launched new browser session', data: session }
  } catch (e) {
    activeCount = Math.max(0, activeCount - 1)
    return { ok: false, summary: 'Failed to launch browser', error: e instanceof Error ? e.message : String(e) }
  }
}

/** Retrieve an existing session by owner ID, or null if not found. */
export function getSession(ownerId: string): BrowserSession | null {
  return sessions.get(ownerId) ?? null
}

/**
 * Create or retrieve a page within an existing session, labeled with a user-friendly agent-
 * controlled tab label (e.g. 'main', '2', ...). If a page with that label already exists,
 * return it (reuse). Otherwise, create a new one.
 */
export async function getOrCreatePage(session: BrowserSession, tabLabel: string): Promise<ManagerResult<Page>> {
  const existing = session.pages.get(tabLabel)
  if (existing && !existing.isClosed()) return { ok: true, summary: 'Reused existing page', data: existing }

  try {
    const page = await session.context.newPage()
    page.on('close', () => {
      if (session.pages.get(tabLabel) === page) session.pages.delete(tabLabel)
    })
    session.pages.set(tabLabel, page)
    return { ok: true, summary: 'Created new page', data: page }
  } catch (e) {
    return { ok: false, summary: 'Failed to create browser page', error: e instanceof Error ? e.message : String(e) }
  }
}

/** Close a specific tab by label and remove it from the session. */
export async function closePage(session: BrowserSession, tabLabel: string): Promise<void> {
  const page = session.pages.get(tabLabel)
  if (!page) return
  session.pages.delete(tabLabel)
  session.refCounters.delete(tabLabel)
  try {
    if (!page.isClosed()) await page.close()
  } catch {
    // already closed
  }
}

/** List all tab labels in a session. */
export function listPages(session: BrowserSession): string[] {
  return Array.from(session.pages.keys())
}

/**
 * Dispose a session entirely (close all pages, browser context, and browser process). Called
 * when a tab is closed or a subagent run ends.
 */
export async function disposeSession(ownerId: string): Promise<void> {
  const session = sessions.get(ownerId)
  if (!session) return

  sessions.delete(ownerId)
  activeCount = Math.max(0, activeCount - 1)

  try {
    await session.context.close()
  } catch {
    // context/pages may already be closed
  }
  try {
    await session.browser.close()
  } catch {
    // already closed or errored
  }
}

/** Dispose all sessions (app-quit path). Called from index.ts's before-quit handler. */
export async function disposeAllSessions(): Promise<void> {
  const ownerIds = Array.from(sessions.keys())
  await Promise.all(ownerIds.map((id) => disposeSession(id)))
}

/** True if any session is currently registered for this owner (avoids launching Playwright
 *  just to check — used by the settings/approval flow to decide whether to describe a
 *  mutating action as "on the current page" vs. implicitly opening one). */
export function hasSession(ownerId: string): boolean {
  return sessions.has(ownerId)
}
