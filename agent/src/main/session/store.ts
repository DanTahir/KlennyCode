import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { TabSession } from '@shared/types'
import { DEFAULT_MAIN_MODEL } from '@shared/types'

function sessionsDir(): string {
  return join(app.getPath('userData'), 'sessions')
}

function sessionFile(workspace: string): string {
  const slug = Buffer.from(workspace).toString('base64url')
  return join(sessionsDir(), `${slug}.json`)
}

export class SessionStore {
  private tabs: TabSession[] = []
  private workspace: string | null = null

  async load(workspace: string): Promise<TabSession[]> {
    this.workspace = workspace
    await mkdir(sessionsDir(), { recursive: true })
    try {
      const raw = await readFile(sessionFile(workspace), 'utf8')
      this.tabs = (JSON.parse(raw) as TabSession[]).map((t) => ({ totalSavingsUsd: 0, ...t }))
    } catch {
      this.tabs = [this.createEmptyTab()]
    }
    if (this.tabs.length === 0) this.tabs = [this.createEmptyTab()]
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

  async closeTab(tabId: string): Promise<TabSession[]> {
    this.tabs = this.tabs.filter((t) => t.id !== tabId)
    if (this.tabs.length === 0) this.tabs.push(this.createEmptyTab())
    await this.persist()
    return this.tabs
  }

  async updateTab(tab: TabSession): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === tab.id)
    if (idx >= 0) {
      tab.updatedAt = Date.now()
      this.tabs[idx] = tab
      await this.persist()
    }
  }

  private async persist(): Promise<void> {
    if (!this.workspace) return
    await mkdir(sessionsDir(), { recursive: true })
    await writeFile(sessionFile(this.workspace), JSON.stringify(this.tabs, null, 2), 'utf8')
  }
}

export const sessionStore = new SessionStore()
