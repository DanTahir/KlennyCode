import type { AppSettings, TabApprovalMode } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

/** Per-tab approval-mode dropdown shown next to Send/Stop. 'default' follows whatever
 *  AppSettings.approvalMode currently is; the other three options override it just for this
 *  tab. Selecting "Accept all" on a pending approval card sets this to 'auto' automatically —
 *  see the resolveApproval IPC handler — but the user can switch it back afterward. */
export function ApprovalModeSelect({
  tabId,
  mode,
  globalMode
}: {
  tabId: string
  mode?: TabApprovalMode
  globalMode: AppSettings['approvalMode']
}) {
  const { setTabs } = useAppStore()
  const value: TabApprovalMode = mode ?? 'default'

  const labelForDefault =
    globalMode === 'auto' ? 'Auto approve' : globalMode === 'command' ? 'Command approve' : 'Manual approve'

  return (
    <select
      className="bg-klenny-bg border border-klenny-border rounded px-2 py-1.5 text-xs"
      value={value}
      title="Approval mode for this tab"
      onChange={(e) =>
        void window.klenny
          .setTabApprovalMode(tabId, e.target.value as TabApprovalMode)
          .then(() => window.klenny.listTabs().then(setTabs))
      }
    >
      <option value="default">Setting default ({labelForDefault})</option>
      <option value="manual">Manual approve</option>
      <option value="command">Command approve</option>
      <option value="auto">Auto approve</option>
    </select>
  )
}
