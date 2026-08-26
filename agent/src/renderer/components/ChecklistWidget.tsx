import type { ChecklistBlock } from '@shared/types'

/** Live progress widget for a plan's checklist — rendered by MessageBubble for any ChatMessage
 *  whose sole block is a ChecklistBlock (see MessageBubble.tsx). The block is mutated in place
 *  (same message id) as update_checklist tool calls come in, so this just reflects whatever
 *  done/not-done state is currently on the block — no local state of its own. */
export function ChecklistWidget({ block }: { block: ChecklistBlock }) {
  const doneCount = block.items.filter((it) => it.done).length
  const totalCount = block.items.length

  return (
    <div className="w-full bg-klenny-panel2 border border-klenny-accent/30 rounded-lg p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-klenny-accent">{block.title}</h3>
        <span className="text-xs text-klenny-muted">
          {doneCount}/{totalCount}
        </span>
      </div>
      <div className="space-y-2">
        {block.items.map((item) => (
          <div key={item.id} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.done}
              disabled
              readOnly
              className="mt-0.5 rounded cursor-default accent-klenny-accent"
            />
            <div className="flex-1 flex flex-col">
              <span className={item.done ? 'line-through text-klenny-muted' : 'text-klenny-text'}>{item.text}</span>
              {item.evidence && (
                <span className="text-xs text-klenny-muted italic mt-0.5">Verified: {item.evidence}</span>
              )}
              {item.evidenceQuality === 'unverified-no-tool-calls' && (
                <span className="text-xs text-amber-400/90 mt-0.5">
                  ⚠ Marked done in a turn that made no tool calls — nothing backs this up
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
