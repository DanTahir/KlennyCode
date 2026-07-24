import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import './testElectronMock'
import { electronMockState } from './testElectronMock'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScheduledTask } from '../shared/types'

const { scheduledTaskManager } = await import('../src/main/scheduler/manager')

const tempDirs: string[] = []

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'klenny-scheduler-test-'))
  tempDirs.push(dir)
  electronMockState.userDataDir = dir
  scheduledTaskManager.stopTicking()
  await scheduledTaskManager.load()
})

afterEach(async () => {
  scheduledTaskManager.stopTicking()
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('ScheduledTaskManager CRUD + persistence', () => {
  test('create() persists a task with a computed nextRunAt', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Daily digest',
      prompt: 'Summarize my inbox',
      schedule: '0 8 * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    expect(task.id).toBeTruthy()
    expect(task.enabled).toBe(true)
    expect(task.nextRunAt).toBeGreaterThan(Date.now())
    expect(scheduledTaskManager.list()).toHaveLength(1)
  })

  test('create() with an invalid cron expression leaves nextRunAt null instead of throwing', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Bad schedule',
      prompt: 'x',
      schedule: 'not a cron expression',
      targetWorkspace: null,
      maxCostUsd: null
    })
    expect(task.nextRunAt).toBeNull()
  })

  test('update() patches fields and recomputes nextRunAt when schedule changes', async () => {
    const task = await scheduledTaskManager.create({
      name: 'A',
      prompt: 'x',
      schedule: '0 8 * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    const originalNextRun = task.nextRunAt
    const updated = await scheduledTaskManager.update(task.id, { schedule: '0 9 * * *' })
    expect(updated).not.toBeNull()
    expect(updated!.nextRunAt).not.toBe(originalNextRun)
  })

  test('update() returns null for an unknown id', async () => {
    const result = await scheduledTaskManager.update('does-not-exist', { name: 'x' })
    expect(result).toBeNull()
  })

  test('delete() removes the task', async () => {
    const task = await scheduledTaskManager.create({
      name: 'A',
      prompt: 'x',
      schedule: '0 8 * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    await scheduledTaskManager.delete(task.id)
    expect(scheduledTaskManager.list()).toHaveLength(0)
  })

  test('tasks persist across a reload from disk', async () => {
    await scheduledTaskManager.create({
      name: 'Persisted',
      prompt: 'x',
      schedule: '0 8 * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    await scheduledTaskManager.load()
    const tasks = scheduledTaskManager.list()
    expect(tasks).toHaveLength(1)
    expect(tasks[0].name).toBe('Persisted')
  })

  test('load() resets a lingering in-progress-like task rather than leaving stale state (crash recovery)', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Crashed mid-run',
      prompt: 'x',
      schedule: '0 8 * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    // Simulate a task that never got a chance to record lastExitStatus before a crash.
    await scheduledTaskManager.update(task.id, { lastRunAt: Date.now() - 1000, lastExitStatus: null })
    await scheduledTaskManager.load()
    const reloaded = scheduledTaskManager.list().find((t) => t.id === task.id)
    expect(reloaded).toBeDefined()
    // nextRunAt should be recomputed (not left stale/null) after reload.
    expect(reloaded!.nextRunAt).toBeGreaterThan(Date.now())
  })
})

describe('ScheduledTaskManager tick execution', () => {
  test('a due, enabled task fires exactly once via the registered runner and records the result', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Due now',
      prompt: 'x',
      schedule: '* * * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    // Force it due immediately regardless of the real cron schedule's next tick.
    await scheduledTaskManager.update(task.id, { nextRunAt: Date.now() - 1 })

    let callCount = 0
    scheduledTaskManager.setRunner(async (t: ScheduledTask) => {
      callCount++
      expect(t.id).toBe(task.id)
      return { status: 'success' as const, summaryPreview: 'did the thing' }
    })

    // Directly invoke the private tick loop via startTicking's immediate first tick, then stop
    // before the interval can fire a second time.
    scheduledTaskManager.startTicking()
    await new Promise((r) => setTimeout(r, 50))
    scheduledTaskManager.stopTicking()

    expect(callCount).toBe(1)
    const updated = scheduledTaskManager.list().find((t) => t.id === task.id)
    expect(updated!.lastExitStatus).toBe('success')
    expect(updated!.lastOutputPreview).toBe('did the thing')
    expect(updated!.lastRunAt).not.toBeNull()
  })

  test('a disabled task never fires even when due', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Disabled',
      prompt: 'x',
      schedule: '* * * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    await scheduledTaskManager.update(task.id, { nextRunAt: Date.now() - 1, enabled: false })

    let called = false
    scheduledTaskManager.setRunner(async () => {
      called = true
      return { status: 'success' as const, summaryPreview: '' }
    })

    scheduledTaskManager.startTicking()
    await new Promise((r) => setTimeout(r, 50))
    scheduledTaskManager.stopTicking()

    expect(called).toBe(false)
  })

  test('a task not yet due does not fire', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Not due',
      prompt: 'x',
      schedule: '0 0 1 1 *', // once a year, effectively never due in this test window
      targetWorkspace: null,
      maxCostUsd: null
    })
    void task

    let called = false
    scheduledTaskManager.setRunner(async () => {
      called = true
      return { status: 'success' as const, summaryPreview: '' }
    })

    scheduledTaskManager.startTicking()
    await new Promise((r) => setTimeout(r, 50))
    scheduledTaskManager.stopTicking()

    expect(called).toBe(false)
  })

  test('a runner that throws is captured as an error status, not an unhandled rejection', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Throws',
      prompt: 'x',
      schedule: '* * * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    await scheduledTaskManager.update(task.id, { nextRunAt: Date.now() - 1 })

    scheduledTaskManager.setRunner(async () => {
      throw new Error('boom')
    })

    scheduledTaskManager.startTicking()
    await new Promise((r) => setTimeout(r, 50))
    scheduledTaskManager.stopTicking()

    const updated = scheduledTaskManager.list().find((t) => t.id === task.id)
    expect(updated!.lastExitStatus).toBe('error')
    expect(updated!.lastOutputPreview).toContain('boom')
  })
})

describe('ScheduledTaskManager maxRuns (limited-repetition / one-shot tasks)', () => {
  test('create() defaults maxRuns to null (unlimited) and runCount to 0', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Unlimited',
      prompt: 'x',
      schedule: '0 8 * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    expect(task.maxRuns).toBeNull()
    expect(task.runCount).toBe(0)
  })

  test('a task with maxRuns: 1 (one-shot) fires once, then self-deletes instead of rescheduling', async () => {
    const task = await scheduledTaskManager.create({
      name: 'One-shot reminder',
      prompt: 'x',
      schedule: '* * * * *',
      targetWorkspace: null,
      maxCostUsd: null,
      maxRuns: 1
    })
    await scheduledTaskManager.update(task.id, { nextRunAt: Date.now() - 1 })

    let receivedFinalRunFlag: boolean | undefined
    scheduledTaskManager.setRunner(async (_t, isFinalRun) => {
      receivedFinalRunFlag = isFinalRun
      return { status: 'success' as const, summaryPreview: 'done' }
    })

    scheduledTaskManager.startTicking()
    await new Promise((r) => setTimeout(r, 50))
    scheduledTaskManager.stopTicking()

    expect(receivedFinalRunFlag).toBe(true)
    expect(scheduledTaskManager.list().find((t) => t.id === task.id)).toBeUndefined()
  })

  test('a task with maxRuns: 3 fires up to 3 times then self-deletes, incrementing runCount each time', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Three times',
      prompt: 'x',
      schedule: '* * * * *',
      targetWorkspace: null,
      maxCostUsd: null,
      maxRuns: 3
    })

    let callCount = 0
    scheduledTaskManager.setRunner(async () => {
      callCount++
      return { status: 'success' as const, summaryPreview: `run ${callCount}` }
    })

    // Fire it three times, forcing it due each time (ticking wouldn't naturally re-fire within
    // the same minute otherwise).
    for (let i = 0; i < 3; i++) {
      const stillThere = scheduledTaskManager.list().find((t) => t.id === task.id)
      expect(stillThere).toBeDefined()
      await scheduledTaskManager.update(task.id, { nextRunAt: Date.now() - 1 })
      scheduledTaskManager.startTicking()
      await new Promise((r) => setTimeout(r, 50))
      scheduledTaskManager.stopTicking()
    }

    expect(callCount).toBe(3)
    expect(scheduledTaskManager.list().find((t) => t.id === task.id)).toBeUndefined()
  })

  test('a task with maxRuns unset (null) keeps rescheduling indefinitely instead of self-deleting', async () => {
    const task = await scheduledTaskManager.create({
      name: 'Recurring',
      prompt: 'x',
      schedule: '* * * * *',
      targetWorkspace: null,
      maxCostUsd: null
    })
    await scheduledTaskManager.update(task.id, { nextRunAt: Date.now() - 1 })

    scheduledTaskManager.setRunner(async () => ({ status: 'success' as const, summaryPreview: 'x' }))

    scheduledTaskManager.startTicking()
    await new Promise((r) => setTimeout(r, 50))
    scheduledTaskManager.stopTicking()

    const updated = scheduledTaskManager.list().find((t) => t.id === task.id)
    expect(updated).toBeDefined()
    expect(updated!.runCount).toBe(1)
    expect(updated!.nextRunAt).toBeGreaterThan(Date.now())
  })
})
