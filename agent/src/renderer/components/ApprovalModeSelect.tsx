import type { AppSettings, TabApprovalMode } from '@shared/types'
import { useAppStore } from '../store/useAppStore'

/** Per-tab approval-mode dropdown shown next to Send/Stop. 'default' follows whatever
 *  AppSettings.approvalMode currently is; the other options override it just for this tab.
 *  Selecting "Accept all" on a pending approval card sets this to 'auto' automatically — see
 *  the resolveApproval IPC handler — but the user can switch it back afterward.
 *
 *  Assistant-kind tabs have file/memory write tools but no run_command tool, so "Command
 *  approve" (which only affects run_command approval) is hidden for them via `hideCommand` —
 *  it would be a distinction without a difference and just add UI clutter. */
export function ApprovalModeSelect({
  tabId,
  mode,
  globalMode,
  hideCommand
}: {
  tabId: string
  mode?: TabApprovalMode
  globalMode: AppSettings['approvalMode']
  hideCommand?: boolean
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
      {!hideCommand && <option value="command">Command approve</option>}
      <option value="auto">Auto approve</option>
    </select>
  )
}
