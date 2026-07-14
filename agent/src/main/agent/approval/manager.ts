import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import simpleGit from 'simple-git'
import { app } from 'electron'
import { nanoid } from 'nanoid'
import type { ApprovalDecision, PendingAction, PendingActionKind } from '@shared/types'
import type { ApprovalMode } from '@shared/types'

export class ApprovalManager {
  private pending = new Map<string, PendingAction>()
  private resolvers = new Map<string, (decision: ApprovalDecision) => void>()
  /** Tabs for which the user has chosen "accept all" — scoped per-tab, not global. */
  private acceptAllTabs = new Set<string>()
  private checkpointDir: string | null = null
  private git: ReturnType<typeof simpleGit> | null = null

  async init(workspace: string): Promise<void> {
    this.checkpointDir = join(app.getPath('userData'), 'checkpoints', Buffer.from(workspace).toString('base64url'))
    await mkdir(this.checkpointDir, { recursive: true })
    this.git = simpleGit(this.checkpointDir)
    try {
      await this.git.init()
    } catch {
      // already init
    }
  }

  setMode(mode: ApprovalMode): void {
    if (mode === 'manual') this.acceptAllTabs.clear()
  }

  async createCheckpoint(workspace: string): Promise<string> {
    if (!this.git || !this.checkpointDir) await this.init(workspace)
    const id = nanoid()
    const marker = join(this.checkpointDir!, `checkpoint-${id}.json`)
    await writeFile(marker, JSON.stringify({ id, at: Date.now(), workspace }), 'utf8')
    try {
      await this.git!.add('.')
      await this.git!.commit(`checkpoint ${id}`, undefined, { '--allow-empty': null })
    } catch {
      // best effort
    }
    return id
  }

  queueAction(action: Omit<PendingAction, 'id' | 'createdAt'>): PendingAction {
    const full: PendingAction = { ...action, id: nanoid(), createdAt: Date.now() }
    this.pending.set(full.id, full)
    return full
  }

  getPending(tabId?: string): PendingAction[] {
    const all = [...this.pending.values()]
    return tabId ? all.filter((p) => p.tabId === tabId) : all
  }

  waitForDecision(actionId: string): Promise<ApprovalDecision> {
    const action = this.pending.get(actionId)
    if (action && this.acceptAllTabs.has(action.tabId)) return Promise.resolve('accept')
    return new Promise((resolve) => {
      this.resolvers.set(actionId, resolve)
    })
  }

  resolve(actionId: string, decision: ApprovalDecision): void {
    const action = this.pending.get(actionId)
    if (decision === 'accept_all' && action) this.acceptAllTabs.add(action.tabId)
    const resolver = this.resolvers.get(actionId)
    if (resolver) {
      resolver(decision === 'accept_all' ? 'accept' : decision)
      this.resolvers.delete(actionId)
    }
    this.pending.delete(actionId)
  }

  cancelForTab(tabId: string): void {
    for (const [actionId, action] of this.pending) {
      if (action.tabId !== tabId) continue
      const resolver = this.resolvers.get(actionId)
      if (resolver) {
        resolver('reject')
        this.resolvers.delete(actionId)
      }
      this.pending.delete(actionId)
    }
  }

  /** Clears per-tab "accept all" state — call when a tab is closed for good. */
  clearTab(tabId: string): void {
    this.acceptAllTabs.delete(tabId)
  }

  buildPendingFromTool(
    tabId: string,
    toolCallId: string,
    kind: PendingActionKind,
    title: string,
    extra: Partial<PendingAction>
  ): PendingAction {
    return this.queueAction({ tabId, toolCallId, kind, title, ...extra })
  }
}

export const approvalManager = new ApprovalManager()
