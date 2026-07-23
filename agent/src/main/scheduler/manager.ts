/**
 * ScheduledTaskManager (Phase 4 of the Personal Assistant Platform plan).
 *
 * Persists a list of recurring tasks and, via a minute-granularity tick loop, fires due tasks
 * by running them as fully-unattended subagents (reusing the existing runSubagent/agentLoop
 * path, which already forces approvalMode: 'auto'). Scheduled-task subagents never get
 * `scheduler_create_task`/update/delete in their tool allowlist — no metaprogramming, per the
 * plan's runaway-cost mitigation.
 */
import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import { CronExpressionParser } from 'cron-parser'
import type { ScheduledTask } from '@shared/types'

const TICK_INTERVAL_MS = 60_000

function tasksPath(): string {
  return join(app.getPath('userData'), 'scheduled-tasks.json')
}

/** Runs one scheduled task as an unattended subagent. Wired up by main/index.ts at startup to
 *  avoid a circular import between this module and orchestrator.ts. Must resolve with a short
 *  summary of the run outcome and never throw — failures should be captured in the returned
 *  status/summary instead so the tick loop can keep going. */
export type ScheduledTaskRunner = (task: ScheduledTask) => Promise<{ status: 'success' | 'error'; summaryPreview: string }>

class ScheduledTaskManager {
  private tasks: ScheduledTask[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private runner: ScheduledTaskRunner | null = null
  private runningIds = new Set<string>()

  setRunner(runner: ScheduledTaskRunner): void {
    this.runner = runner
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(tasksPath(), 'utf8')
      this.tasks = JSON.parse(raw) as ScheduledTask[]
    } catch {
      this.tasks = []
    }
    // Crash/restart recovery: nothing left mid-flight should be trusted as still running —
    // recompute next fire time normally rather than leaving stale state.
    for (const t of this.tasks) {
      this.recomputeNextRun(t)
    }
    await this.persist()
  }

  startTicking(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
    void this.tick()
  }

  stopTicking(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(): ScheduledTask[] {
    return this.tasks
  }

  async create(input: Pick<ScheduledTask, 'name' | 'prompt' | 'schedule' | 'targetWorkspace' | 'maxCostUsd'>): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: nanoid(),
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      targetWorkspace: input.targetWorkspace,
      maxCostUsd: input.maxCostUsd,
      enabled: true,
      createdAt: Date.now(),
      lastRunAt: null,
      lastExitStatus: null,
      lastOutputPreview: null,
      nextRunAt: null
    }
    this.recomputeNextRun(task)
    this.tasks.push(task)
    await this.persist()
    return task
  }

  async update(id: string, patch: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    const idx = this.tasks.findIndex((t) => t.id === id)
    if (idx < 0) return null
    const updated = { ...this.tasks[idx], ...patch }
    if (patch.schedule) this.recomputeNextRun(updated)
    this.tasks[idx] = updated
    await this.persist()
    return updated
  }

  async delete(id: string): Promise<void> {
    this.tasks = this.tasks.filter((t) => t.id !== id)
    await this.persist()
  }

  private recomputeNextRun(task: ScheduledTask): void {
    try {
      const interval = CronExpressionParser.parse(task.schedule, { currentDate: new Date() })
      task.nextRunAt = interval.next().getTime()
    } catch {
      task.nextRunAt = null
    }
  }

  private async tick(): Promise<void> {
    if (!this.runner) return
    const now = Date.now()
    for (const task of this.tasks) {
      if (!task.enabled) continue
      if (this.runningIds.has(task.id)) continue
      if (task.nextRunAt === null || task.nextRunAt > now) continue

      this.runningIds.add(task.id)
      try {
        const result = await this.runner(task)
        task.lastRunAt = now
        task.lastExitStatus = result.status
        task.lastOutputPreview = result.summaryPreview.slice(0, 500)
      } catch (e) {
        task.lastRunAt = now
        task.lastExitStatus = 'error'
        task.lastOutputPreview = e instanceof Error ? e.message : String(e)
      } finally {
        this.runningIds.delete(task.id)
        this.recomputeNextRun(task)
        await this.persist()
      }
    }
  }

  private async persist(): Promise<void> {
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(tasksPath(), JSON.stringify(this.tasks, null, 2), 'utf8')
  }
}

export const scheduledTaskManager = new ScheduledTaskManager()
