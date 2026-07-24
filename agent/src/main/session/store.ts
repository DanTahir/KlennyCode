import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { ArchivedTabSession, TabSession } from '@shared/types'
import { DEFAULT_MAIN_MODEL } from '@shared/types'

/** Max number of closed chats kept in history per workspace, oldest dropped first. */
const MAX_HISTORY = 200

function sessionsDir(): string {
  return join(app.getPath('userData'), 'sessions')
}

function slugFor(workspace: string): string {
  return Buffer.from(workspace).toString('base64url')
}

function sessionFile(workspace: string): string {
  return join(sessionsDir(), `${slugFor(workspace)}.json`)
}

function historyFile(workspace: string): string {
  return join(sessionsDir(), `${slugFor(workspace)}.history.json`)
}

export class SessionStore {
  private tabs: TabSession[] = []
  private history: ArchivedTabSession[] = []
  private workspace: string | null = null

  /** The workspace currently loaded in memory (i.e. what the UI is showing right now), or null
   *  if none is open. Used by callers that need to decide whether a given workspace's tabs can
   *  be mutated live (via this store) or must be patched on disk instead — see
   *  deliverScheduledTaskResult in orchestrator.ts. */
  getWorkspace(): string | null {
    return this.workspace
  }

  async load(workspace: string): Promise<TabSession[]> {
    // Ephemeral Assistant tabs are workspace-independent by design (see TabSession.kind doc
    // comment) — carry any currently-open ones across the switch instead of losing them, since
    // they were never written to the outgoing workspace's session file to begin with.
    const liveAssistantTabs = this.tabs.filter((t) => t.kind === 'assistant')
    this.workspace = workspace
    await mkdir(sessionsDir(), { recursive: true })
    try {
      const raw = await readFile(sessionFile(workspace), 'utf8')
      this.tabs = (JSON.parse(raw) as TabSession[]).map((t) => ({ totalSavingsUsd: 0, ...t }))
    } catch {
      this.tabs = [this.createEmptyTab()]
    }
    if (this.tabs.length === 0) this.tabs = [this.createEmptyTab()]
    this.tabs.push(...liveAssistantTabs)

    try {
      const raw = await readFile(historyFile(workspace), 'utf8')
      this.history = JSON.parse(raw) as ArchivedTabSession[]
    } catch {
      this.history = []
    }

    return this.tabs
  }

  createEmptyTab(): TabSession {
    const now = Date.now()
    return {
      id: nanoid(),
      title: 'New chat',
      mode: 'agent',
      model: DEFAULT_MAIN_MODEL,
      createdAt: now,
      updatedAt: now,
      messages: [],
      totalCostUsd: 0,
      totalSavingsUsd: 0
    }
  }

  getTabs(): TabSession[] {
    return this.tabs
  }

  getTab(id: string): TabSession | undefined {
    return this.tabs.find((t) => t.id === id)
  }

  async createTab(): Promise<TabSession> {
    const tab = this.createEmptyTab()
    this.tabs.push(tab)
    await this.persist()
    return tab
  }

  /** Creates a brand-new, ephemeral "Assistant" tab (see TabSession.kind doc comment). Every
   *  call creates a distinct tab — there is no create-or-focus singleton behavior in v1.
   *  Assistant tabs live only in memory: they are never written to the per-workspace session
   *  file (see persist()) and never archived to History on close (see closeTab()), so they
   *  disappear entirely on close or app quit. */
  createAssistantTab(): TabSession {
    const tab = { ...this.createEmptyTab(), kind: 'assistant' as const, title: 'Assistant' }
    this.tabs.push(tab)
    return tab
  }

  /** Closes a tab, archiving it into history (unless it never had any messages, or it's an
   *  ephemeral Assistant tab — those are excluded from History entirely per the v1 design). */
  async closeTab(tabId: string): Promise<TabSession[]> {
    const tab = this.tabs.find((t) => t.id === tabId)
    this.tabs = this.tabs.filter((t) => t.id !== tabId)
    if (tab && tab.kind !== 'assistant' && tab.messages.length > 0) {
      this.history.unshift({ ...tab, closedAt: Date.now() })
      if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY
      await this.persistHistory()
    }
    if (this.tabs.filter((t) => t.kind !== 'assistant').length === 0) this.tabs.push(this.createEmptyTab())
    await this.persist()
    return this.tabs
  }

  async updateTab(tab: TabSession): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === tab.id)
    if (idx >= 0) {
      tab.updatedAt = Date.now()
      this.tabs[idx] = tab
      if (tab.kind !== 'assistant') await this.persist()
    }
  }

  getHistory(): ArchivedTabSession[] {
    return this.history
  }

  /** Removes an archived chat permanently. */
  async deleteHistoryEntry(tabId: string): Promise<ArchivedTabSession[]> {
    this.history = this.history.filter((t) => t.id !== tabId)
    await this.persistHistory()
    return this.history
  }

  /** Restores an archived chat as a new live tab (keeps its messages/title, gets a fresh id). */
  async reopenHistoryEntry(tabId: string): Promise<TabSession | null> {
    const archived = this.history.find((t) => t.id === tabId)
    if (!archived) return null
    const now = Date.now()
    const { closedAt: _closedAt, ...rest } = archived
    const tab: TabSession = { ...rest, id: nanoid(), updatedAt: now }
    this.tabs.push(tab)
    this.history = this.history.filter((t) => t.id !== tabId)
    await Promise.all([this.persist(), this.persistHistory()])
    return tab
  }

  private async persist(): Promise<void> {
    if (!this.workspace) return
    await mkdir(sessionsDir(), { recursive: true })
    // Assistant-kind tabs are intentionally ephemeral (see TabSession.kind doc comment) — never
    // written to disk, so they vanish on close/quit rather than surviving a restart.
    const persistable = this.tabs.filter((t) => t.kind !== 'assistant')
    await writeFile(sessionFile(this.workspace), JSON.stringify(persistable, null, 2), 'utf8')
  }

  private async persistHistory(): Promise<void> {
    if (!this.workspace) return
    await mkdir(sessionsDir(), { recursive: true })
    await writeFile(historyFile(this.workspace), JSON.stringify(this.history, null, 2), 'utf8')
  }
}

export const sessionStore = new SessionStore()

// ---------- Background-workspace file helpers ----------
//
// The SessionStore singleton above only ever holds ONE workspace's tabs/history in memory at a
// time (whatever the UI currently has open). A scheduled task can fire for a *different*
// workspace than the one the user has open right now, so delivering its result there can't go
// through the live in-memory store (that would corrupt the currently-open workspace's state).
// These standalone helpers read/write a given workspace's session+history files directly,
// independent of whatever SessionStore.workspace currently is. They intentionally duplicate the
// tiny amount of file-format logic above rather than refactor the class, to keep the live path
// (used on every turn) untouched.

async function readWorkspaceTabs(workspace: string): Promise<TabSession[]> {
  try {
    const raw = await readFile(sessionFile(workspace), 'utf8')
    return JSON.parse(raw) as TabSession[]
  } catch {
    return []
  }
}

async function writeWorkspaceTabs(workspace: string, tabs: TabSession[]): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(sessionFile(workspace), JSON.stringify(tabs, null, 2), 'utf8')
}

async function readWorkspaceHistory(workspace: string): Promise<ArchivedTabSession[]> {
  try {
    const raw = await readFile(historyFile(workspace), 'utf8')
    return JSON.parse(raw) as ArchivedTabSession[]
  } catch {
    return []
  }
}

async function writeWorkspaceHistory(workspace: string, history: ArchivedTabSession[]): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(historyFile(workspace), JSON.stringify(history, null, 2), 'utf8')
}

/** Appends `message` to the given tab, wherever it lives in `workspace`'s persisted state:
 *  - if `tabId` matches a live (non-archived) tab, appends to it in place;
 *  - else if it matches an archived (History) entry, restores it as a live tab (fresh id, like
 *    reopenHistoryEntry) and appends to it, removing it from history;
 *  - else (not found anywhere, or `tabId` is null) creates a brand-new tab titled
 *    `fallbackTitle`/`fallbackKind` and appends to it.
 *  Operates purely on disk — does NOT touch the live SessionStore singleton, so it is safe to
 *  call for a workspace the user doesn't currently have open. Returns the id of the tab the
 *  message actually landed in. */
export async function appendMessageToWorkspaceTab(
  workspace: string,
  tabId: string | null,
  message: TabSession['messages'][number],
  fallbackTitle: string
): Promise<string> {
  const tabs = await readWorkspaceTabs(workspace)
  const idx = tabId ? tabs.findIndex((t) => t.id === tabId) : -1
  if (idx >= 0) {
    tabs[idx] = { ...tabs[idx], messages: [...tabs[idx].messages, message], updatedAt: Date.now() }
    await writeWorkspaceTabs(workspace, tabs)
    return tabs[idx].id
  }

  if (tabId) {
    const history = await readWorkspaceHistory(workspace)
    const archivedIdx = history.findIndex((t) => t.id === tabId)
    if (archivedIdx >= 0) {
      const { closedAt: _closedAt, ...rest } = history[archivedIdx]
      const restored: TabSession = { ...rest, id: nanoid(), messages: [...rest.messages, message], updatedAt: Date.now() }
      tabs.push(restored)
      history.splice(archivedIdx, 1)
      await Promise.all([writeWorkspaceTabs(workspace, tabs), writeWorkspaceHistory(workspace, history)])
      return restored.id
    }
  }

  const now = Date.now()
  const created: TabSession = {
    id: nanoid(),
    title: fallbackTitle,
    mode: 'agent',
    model: DEFAULT_MAIN_MODEL,
    createdAt: now,
    updatedAt: now,
    messages: [message],
    totalCostUsd: 0,
    totalSavingsUsd: 0,
    kind: 'project'
  }
  tabs.push(created)
  await writeWorkspaceTabs(workspace, tabs)
  return created.id
}
