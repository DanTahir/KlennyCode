// Data-only helper for constructing a live-progress checklist's ChatMessage +
// TabSession.activeChecklist shape. Shared by approvePlan() (turn-lifecycle.ts) and the
// create_checklist tool dispatch (loop.ts). Lives in its own module rather than turn-lifecycle.ts
// to avoid a circular import: turn-lifecycle.ts imports agentLoop from loop.ts, so loop.ts can't
// import back from turn-lifecycle.ts.
//
// Deliberately free of any turn/tab-state side effects (no tab.mode writes, no persistence, no
// emits) — approvePlan() runs inside launchAgentLoop's beforeStart callback (pre-turn-loop) while
// create_checklist runs mid-turn from dispatchTool(), and those two contexts shouldn't be coupled
// together here. Both call sites push the returned message onto tab.messages, set
// tab.activeChecklist to the returned value, then handle their own persistence/emit/mode
// transition around it.
import { nanoid } from 'nanoid'
import type { ChatMessage, ChecklistItem, TabSession } from '@shared/types'

export function buildChecklist(
  title: string,
  itemTexts: string[]
): { message: ChatMessage; activeChecklist: NonNullable<TabSession['activeChecklist']> } {
  const items: ChecklistItem[] = itemTexts.map((text, i) => ({ id: `item-${i + 1}`, text, done: false }))
  const message: ChatMessage = {
    id: nanoid(),
    role: 'assistant',
    blocks: [{ type: 'checklist', title, items }],
    createdAt: Date.now()
  }
  return { message, activeChecklist: { messageId: message.id, title, items } }
}
