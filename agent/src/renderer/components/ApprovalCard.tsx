import type { PendingAction } from '@shared/types'
import { DiffViewer } from './DiffViewer'

export function ApprovalCard({ action }: { action: PendingAction }) {
  return (
    <div className="border border-klenny-accent/40 rounded-lg p-3 bg-klenny-panel2">
      <div className="font-medium text-sm mb-2">Approval required: {action.title}</div>
      {action.command && <pre className="text-xs bg-klenny-bg p-2 rounded mb-2">{action.command}</pre>}
      {action.screenshotDataUrl && (
        <img
          src={action.screenshotDataUrl}
          alt="Browser page preview"
          className="max-w-full rounded border border-klenny-border mb-2"
        />
      )}
      {action.filePaths && action.filePaths.length > 1 && (
        <ul className="text-xs text-klenny-muted mb-2 list-disc list-inside">
          {action.filePaths.map((p) => (
            <li key={p} className="font-mono">
              {p}
            </li>
          ))}
        </ul>
      )}
      {action.diff && <DiffViewer diff={action.diff} />}
      <div className="flex gap-2 mt-3">
        <button
          className="px-3 py-1 rounded bg-klenny-accent text-black text-sm"
          onClick={() => void window.klenny.resolveApproval(action.id, 'accept')}
        >
          Accept
        </button>
        <button
          className="px-3 py-1 rounded border border-klenny-border text-sm"
          onClick={() => void window.klenny.resolveApproval(action.id, 'reject')}
        >
          Reject
        </button>
        <button
          className="px-3 py-1 rounded border border-klenny-border text-sm"
          onClick={() => void window.klenny.resolveApproval(action.id, 'accept_all')}
        >
          Accept all
        </button>
      </div>
    </div>
  )
}
