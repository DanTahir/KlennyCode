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
  private acceptAll = false
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
    if (mode === 'manual') this.acceptAll = false
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
    if (this.acceptAll) return Promise.resolve('accept')
    return new Promise((resolve) => {
      this.resolvers.set(actionId, resolve)
    })
  }

  resolve(actionId: string, decision: ApprovalDecision): void {
    if (decision === 'accept_all') this.acceptAll = true
    const resolver = this.resolvers.get(actionId)
    if (resolver) {
      resolver(decision === 'accept_all' ? 'accept' : decision)
      this.resolvers.delete(actionId)
    }
    this.pending.delete(actionId)
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
