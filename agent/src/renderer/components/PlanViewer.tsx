import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PlanArtifact } from '@shared/types'

export function PlanViewer({ plan, onApprove }: { plan: PlanArtifact; onApprove?: () => void }) {
  return (
    <div className="border border-klenny-border rounded-lg p-4 bg-klenny-panel2">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{plan.title}</h3>
        <span className="text-xs text-klenny-muted">{new Date(plan.createdAt).toLocaleString()}</span>
      </div>
      <div className="markdown prose prose-invert max-w-none text-sm">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.markdown}</ReactMarkdown>
      </div>
      {onApprove && (
        <div className="flex gap-2 mt-4">
          <button className="px-3 py-1 rounded bg-klenny-accent text-black text-sm" onClick={onApprove}>
            Approve & switch to Agent mode
          </button>
        </div>
      )}
    </div>
  )
}
