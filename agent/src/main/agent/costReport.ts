// Persistent cost/token accounting across chat completions, broken down by model and by
// project (workspace path). Kept separate from spend.ts (which only tracks a rolling daily
// USD total for spending-cap enforcement) — this module keeps a full historical tally that
// survives restarts and backs the Settings -> Cost Report view.

import { app } from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { CostReport, CostReportRow, UsageInfo } from '@shared/types'

/** Key used for usage recorded while no workspace is open (should be rare in practice). */
const NO_PROJECT_KEY = '(no project)'

interface ModelTotals {
  costUsd: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  cacheWriteTokens: number
}

/** project path -> model id -> running totals */
type CostData = Record<string, Record<string, ModelTotals>>

function dataPath(): string {
  return join(app.getPath('userData'), 'cost-report.json')
}

function emptyTotals(): ModelTotals {
  return { costUsd: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }
}

let cache: CostData | null = null
let queue: Promise<unknown> = Promise.resolve()

async function ensureLoaded(): Promise<CostData> {
  if (cache) return cache
  try {
    const raw = await readFile(dataPath(), 'utf8')
    cache = JSON.parse(raw) as CostData
  } catch {
    cache = {}
  }
  return cache
}

function persist(): void {
  // Serialized via `queue` so concurrent recordUsage() calls (e.g. a main turn plus a
  // subagent streaming in parallel) never interleave writes to the file.
  queue = queue.then(async () => {
    if (!cache) return
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeFile(dataPath(), JSON.stringify(cache, null, 2), 'utf8')
  })
}

/** Records one turn's usage against the given project + model. Fire-and-forget on disk I/O. */
export function recordUsage(project: string | null, model: string, usage: UsageInfo): void {
  void (async () => {
    const data = await ensureLoaded()
    const key = project ?? NO_PROJECT_KEY
    const perProject = (data[key] ??= {})
    const totals = (perProject[model] ??= emptyTotals())
    totals.costUsd += usage.costUsd
    totals.promptTokens += usage.promptTokens
    totals.completionTokens += usage.completionTokens
    totals.cachedTokens += usage.cachedTokens
    totals.cacheWriteTokens += usage.cacheWriteTokens
    persist()
  })()
}

function toRow(model: string, t: ModelTotals): CostReportRow {
  const uncachedTokens = Math.max(t.promptTokens - t.cachedTokens, 0)
  return {
    model,
    costUsd: t.costUsd,
    totalTokens: t.promptTokens + t.completionTokens,
    inputTokens: t.promptTokens,
    outputTokens: t.completionTokens,
    cachedTokens: t.cachedTokens,
    uncachedTokens
  }
}

function sumTotals(list: ModelTotals[]): ModelTotals {
  const sum = emptyTotals()
  for (const t of list) {
    sum.costUsd += t.costUsd
    sum.promptTokens += t.promptTokens
    sum.completionTokens += t.completionTokens
    sum.cachedTokens += t.cachedTokens
    sum.cacheWriteTokens += t.cacheWriteTokens
  }
  return sum
}

function rowsFor(perModel: Record<string, ModelTotals>): CostReportRow[] {
  const rows = Object.entries(perModel)
    .map(([model, t]) => toRow(model, t))
    .sort((a, b) => b.costUsd - a.costUsd)
  const all = toRow('all', sumTotals(Object.values(perModel)))
  return [...rows, all]
}

export async function getCostReport(currentProject: string | null): Promise<CostReport> {
  const data = await ensureLoaded()
  const key = currentProject ?? NO_PROJECT_KEY
  const currentProjectRows = rowsFor(data[key] ?? {})

  const allPerModel: Record<string, ModelTotals> = {}
  for (const perProject of Object.values(data)) {
    for (const [model, t] of Object.entries(perProject)) {
      const acc = (allPerModel[model] ??= emptyTotals())
      acc.costUsd += t.costUsd
      acc.promptTokens += t.promptTokens
      acc.completionTokens += t.completionTokens
      acc.cachedTokens += t.cachedTokens
      acc.cacheWriteTokens += t.cacheWriteTokens
    }
  }

  return {
    currentProject,
    currentProjectRows,
    allProjectsRows: rowsFor(allPerModel)
  }
}

/** Wipes every recorded total for every project and model. */
export async function resetCostReport(): Promise<void> {
  cache = {}
  persist()
  await queue
}
