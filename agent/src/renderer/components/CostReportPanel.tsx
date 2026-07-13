import { useEffect, useState } from 'react'
import type { CostReport, CostReportRow } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function formatTokens(n: number): string {
  return n.toLocaleString()
}

function CostTable({
  title,
  rows,
  modelName
}: {
  title: string
  rows: CostReportRow[]
  modelName: (id: string) => string
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium">{title}</h3>
      {rows.length <= 1 ? (
        <p className="text-sm text-klenny-muted">No usage recorded yet.</p>
      ) : (
        <div className="overflow-x-auto border border-klenny-border rounded">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-klenny-panel2 text-left">
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2 text-right">Total tokens</th>
                <th className="px-3 py-2 text-right">In tokens</th>
                <th className="px-3 py-2 text-right">Out tokens</th>
                <th className="px-3 py-2 text-right">Cached</th>
                <th className="px-3 py-2 text-right">Uncached</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.model}
                  className={`border-t border-klenny-border ${r.model === 'all' ? 'font-semibold bg-klenny-panel2' : ''}`}
                >
                  <td className="px-3 py-2">{r.model === 'all' ? 'All models' : modelName(r.model)}</td>
                  <td className="px-3 py-2 text-right">{formatCost(r.costUsd)}</td>
                  <td className="px-3 py-2 text-right">{formatTokens(r.totalTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatTokens(r.inputTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatTokens(r.outputTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatTokens(r.cachedTokens)}</td>
                  <td className="px-3 py-2 text-right">{formatTokens(r.uncachedTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function CostReportPanel() {
  const { models, setPanel } = useAppStore()
  const [report, setReport] = useState<CostReport | null>(null)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    void window.klenny.getCostReport().then(setReport)
  }, [])

  const modelName = (id: string) => models.find((m) => m.id === id)?.name ?? id

  const reset = async () => {
    if (!window.confirm('Reset the cost report? This clears all recorded cost and token totals for every project and cannot be undone.')) return
    setResetting(true)
    try {
      setReport(await window.klenny.resetCostReport())
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Cost Report</h2>
        <button className="px-3 py-1 rounded border border-klenny-border text-sm" onClick={() => setPanel('settings')}>
          Back to Settings
        </button>
      </div>

      {!report ? (
        <p className="text-sm text-klenny-muted">Loading…</p>
      ) : (
        <>
          <CostTable
            title={`Current project${report.currentProject ? ` — ${report.currentProject}` : ' (none open)'}`}
            rows={report.currentProjectRows}
            modelName={modelName}
          />
          <CostTable title="All projects" rows={report.allProjectsRows} modelName={modelName} />
        </>
      )}

      <button
        className="px-3 py-1 rounded border border-klenny-border text-sm text-klenny-muted hover:text-klenny-text disabled:opacity-50"
        disabled={resetting}
        onClick={() => void reset()}
      >
        Reset cost report
      </button>
    </div>
  )
}
