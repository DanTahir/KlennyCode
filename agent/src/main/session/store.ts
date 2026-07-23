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
