// Fully-unattended agentLoop entry points with no live UI/tab to stream to: scheduled tasks
// (registered with scheduledTaskManager.setRunner() at app startup) and inbound Discord commands
// (see discordBridge.ts). Both build an ephemeral TabSession, run agentLoop against it with a
// restricted tool allowlist (no scheduler_*/task/open_settings_panel — see inline comments), and
// report a text summary back out — to a chat tab for scheduled tasks, to the Discord bridge's
// caller for Discord.
import { BrowserWindow, Notification } from 'electron'
import { nanoid } from 'nanoid'
import type { ChatMessage, ScheduledTask, TabSession } from '@shared/types'
import { getApiKey, loadSettings } from '../../settings'
import { getWorkspace, setWorkspace } from '../../workspace'
import { sessionStore, appendMessageToWorkspaceTab } from '../../session/store'
import { disposeSession as disposeBrowserSession } from '../../browser/manager'
import { truncateSummary } from '../turnControl'
import { updateAssistantMemoryForTab } from '../memory/assistantMemory'
import { agentLoop } from './loop'
import { type SubagentContext, emitToAll } from './state'

/** Runs one scheduled task (Phase 4 of the Personal Assistant Platform plan) as a fully
 *  unattended subagent — no parent tab, no live UI to stream to. Registered with
 *  scheduledTaskManager.setRunner() at app startup (see main/index.ts) to avoid a circular
 *  import between this module and scheduler/manager.ts.
 *
 *  Scheduled-task runs never get scheduler_create_task/update/delete in their tool allowlist —
 *  a scheduled task cannot create, edit, or delete other scheduled tasks (no metaprogramming;
 *  see the plan's runaway-cost mitigation). If `task.targetWorkspace` is set, the global
 *  workspace is temporarily switched to it for the duration of the run and restored afterward —
 *  a known limitation: if the user is actively working in a different project tab while a
 *  scheduled task fires, coding-tool calls in *that* live tab could transiently resolve against
 *  the scheduled task's workspace until it finishes. Acceptable for v1; a future version could
 *  give every tab its own workspace instead of one global one. */
export async function runScheduledTask(
  task: ScheduledTask,
  isFinalRun: boolean
): Promise<{ status: 'success' | 'error'; summaryPreview: string }> {
  const apiKey = await getApiKey()
  if (!apiKey) return { status: 'error', summaryPreview: 'OpenRouter API key not set.' }

  const settings = await loadSettings()
  if (settings.automationPermissions['scheduler.run'] !== 'auto') {
    return { status: 'error', summaryPreview: 'Scheduler is disabled by Automation Permissions (scheduler.run).' }
  }

  const previousWorkspace = getWorkspace()
  if (task.targetWorkspace) setWorkspace(task.targetWorkspace)

  const subTab: TabSession = {
    id: `sched_${task.id}_${Date.now()}`,
    title: `Scheduled: ${task.name}`,
    mode: 'agent',
    model: settings.subagentModel,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // No targetWorkspace => force the Assistant tool-only allowlist (ASSISTANT_TOOLS — file
    // tools included, scoped to documentsDirectory, but no run_command/read_terminal/
    // codebase_search) regardless of whatever project happens to be the ambient global workspace
    // right now (see getToolDefinitions()'s isAssistant gate in agentLoop's tools: ... call).
    kind: task.targetWorkspace ? 'project' : 'assistant',
    messages: [
      {
        id: nanoid(),
        role: 'user',
        blocks: [{ type: 'text', text: task.prompt }],
        createdAt: Date.now()
      }
    ],
    totalCostUsd: 0,
    totalSavingsUsd: 0
  }

  const subagentCtx: SubagentContext = {
    allowedTools: [
      'read_file',
      'grep',
      'glob',
      'run_command',
      'web_search',
      'fetch_url',
      'read_memory',
      'write_memory',
      'list_memory',
      'list_projects',
      'gmail_list_messages',
      'gmail_get_message',
      'gmail_send_message',
      'discord_post_message',
      'codebase_search'
      // Deliberately excluded: write_file/edit_file/delete_file (still permitted via
      // ApprovalManager bypass same as any subagent, but not the point of most scheduled
      // tasks — can be revisited if a real use case needs it), scheduler_* (no
      // metaprogramming), open_settings_panel (no renderer to navigate), task (no nested
      // subagents, same as all subagent contexts).
    ]
  }

  const controller = new AbortController()
  let status: 'success' | 'error'
  let summary: string
  try {
    const reason = await agentLoop(subTab, apiKey, settings.subagentModel, emitToAll, controller.signal, 1, subagentCtx)
    summary =
      subTab.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n') || 'Scheduled task completed with no text output.'
    status = reason === 'error' || reason === 'truncation_failed' ? 'error' : 'success'
  } catch (e) {
    status = 'error'
    summary = e instanceof Error ? e.message : String(e)
  } finally {
    setWorkspace(previousWorkspace)
    void disposeBrowserSession(subTab.id).catch(() => {})
  }

  const summaryPreview = truncateSummary(summary)
  try {
    await deliverScheduledTaskResult(task, status, summaryPreview, isFinalRun)
  } catch (e) {
    console.error('Failed to deliver scheduled task result to its tab:', e)
  }
  return { status, summaryPreview }
}

/** Reports a finished scheduled task's result back into a chat tab, per the following
 *  preference order:
 *   1. The tab that created it (`task.creatorTabId`), if it's still open right now.
 *   2. That same tab restored from History, if it was closed but not deleted from history.
 *   3. A brand-new tab — an Assistant tab if the task has no `targetWorkspace`, otherwise a
 *      project tab in `targetWorkspace`.
 *  Only ever mutates the SessionStore singleton (and emits a live `tab_upserted` event) when the
 *  destination workspace matches whatever workspace the UI currently has loaded — a task firing
 *  for a workspace the user doesn't have open right now is instead patched directly into that
 *  workspace's session/history files on disk (see appendMessageToWorkspaceTab), with no live
 *  event, so it's simply there next time that workspace is opened. Assistant-tab destinations are
 *  always live (Assistant tabs only ever exist in memory, workspace-independent). */
async function deliverScheduledTaskResult(
  task: ScheduledTask,
  status: 'success' | 'error',
  summaryPreview: string,
  isFinalRun: boolean
): Promise<void> {
  const header = status === 'success' ? '✅ **Scheduled task finished:**' : '⚠️ **Scheduled task failed:**'
  const finalRunNote = isFinalRun
    ? `\n\n_This was the task's final scheduled run (${task.runCount + 1}/${task.maxRuns}) — it has been removed from the scheduler._`
    : ''
  const message: ChatMessage = {
    id: nanoid(),
    role: 'assistant',
    blocks: [{ type: 'text', text: `${header} *${task.name}*\n\n${summaryPreview}${finalRunNote}` }],
    createdAt: Date.now()
  }

  // Fallback destination if the creator tab (and its history entry) can no longer be found.
  const wantsAssistantFallback = !task.targetWorkspace
  const fallbackTitle = `Scheduled: ${task.name}`

  const creatorIsAssistant = task.creatorTabKind
    ? task.creatorTabKind === 'assistant'
    : wantsAssistantFallback

  if (creatorIsAssistant) {
    // Assistant tabs are workspace-independent and persisted in their own fixed file (see
    // SessionStore.assistantTabsFile) — check the live tab first, then Assistant History (it
    // may have been closed since the task was created), before falling back to a fresh tab.
    let tab = task.creatorTabId ? sessionStore.getTab(task.creatorTabId) : undefined
    if (tab && tab.kind === 'assistant') {
      tab.messages.push(message)
      await sessionStore.updateTab(tab)
      emitToAll({ type: 'tab_upserted', tab })
      notifyIfUnfocused(task)
      updateAssistantMemoryForTab(tab.id)
      return
    }

    if (task.creatorTabId && sessionStore.getAssistantHistory().some((t) => t.id === task.creatorTabId)) {
      const reopened = await sessionStore.reopenAssistantHistoryEntry(task.creatorTabId)
      if (reopened) {
        reopened.messages.push(message)
        await sessionStore.updateTab(reopened)
        emitToAll({ type: 'history_entry_removed', tabId: task.creatorTabId })
        emitToAll({ type: 'tab_upserted', tab: reopened })
        notifyIfUnfocused(task)
        updateAssistantMemoryForTab(reopened.id)
        return
      }
    }

    tab = await sessionStore.createAssistantTab()
    tab.title = fallbackTitle
    tab.messages.push(message)
    await sessionStore.updateTab(tab)
    emitToAll({ type: 'tab_upserted', tab })
    notifyIfUnfocused(task)
    updateAssistantMemoryForTab(tab.id)
    return
  }

  const destinationWorkspace = task.targetWorkspace ?? task.creatorWorkspace
  if (!destinationWorkspace) {
    // No workspace to anchor a project tab to (shouldn't normally happen once creatorWorkspace
    // is populated going forward) — fall back to a fresh Assistant tab so the result isn't lost.
    const tab = await sessionStore.createAssistantTab()
    tab.title = fallbackTitle
    tab.messages.push(message)
    await sessionStore.updateTab(tab)
    emitToAll({ type: 'tab_upserted', tab })
    notifyIfUnfocused(task)
    return
  }

  if (sessionStore.getWorkspace() === destinationWorkspace) {
    // The destination workspace is exactly what the UI has loaded right now — safe to use the
    // live SessionStore so any open window reflects the update immediately.
    let tab = task.creatorTabId ? sessionStore.getTab(task.creatorTabId) : undefined
    if (tab) {
      tab.messages.push(message)
      await sessionStore.updateTab(tab)
      emitToAll({ type: 'tab_upserted', tab })
      notifyIfUnfocused(task)
      return
    }

    if (task.creatorTabId && sessionStore.getHistory().some((t) => t.id === task.creatorTabId)) {
      const reopened = await sessionStore.reopenHistoryEntry(task.creatorTabId)
      if (reopened) {
        reopened.messages.push(message)
        await sessionStore.updateTab(reopened)
        emitToAll({ type: 'history_entry_removed', tabId: task.creatorTabId })
        emitToAll({ type: 'tab_upserted', tab: reopened })
        notifyIfUnfocused(task)
        return
      }
    }

    const created = await sessionStore.createTab()
    created.title = fallbackTitle
    created.messages.push(message)
    await sessionStore.updateTab(created)
    emitToAll({ type: 'tab_upserted', tab: created })
    notifyIfUnfocused(task)
    return
  }

  // Destination workspace isn't the one currently open in the UI — patch it on disk without
  // touching the live SessionStore or emitting any events (nothing to refresh right now; the
  // change will simply be there next time that workspace is opened).
  await appendMessageToWorkspaceTab(destinationWorkspace, task.creatorTabId ?? null, message, fallbackTitle)
  notifyIfUnfocused(task)
}

function notifyIfUnfocused(task: ScheduledTask): void {
  if (!BrowserWindow.getFocusedWindow()) {
    new Notification({ title: 'Klenny Code scheduled task finished', body: task.name }).show()
  }
}

/** Runs an inbound Discord command (see discordBridge.ts) as a fully unattended subagent and
 *  returns the reply text to post back to Discord. Same tool allowlist rationale as
 *  runScheduledTask (no scheduler_x tools, no open_settings_panel, no nested task calls), plus
 *  `discord_post_message` so the subagent could proactively post to a different channel if
 *  asked, though its primary reply is always the returned string (posted by the Discord
 *  message-handler itself). */
export async function runDiscordSubagent(subTab: TabSession, apiKey: string, subagentModel: string): Promise<string> {
  const subagentCtx: SubagentContext = {
    allowedTools: [
      'web_search',
      'fetch_url',
      'read_memory',
      'write_memory',
      'list_memory',
      'list_projects',
      'gmail_list_messages',
      'gmail_get_message',
      'gmail_send_message',
      'discord_post_message'
    ]
  }
  const controller = new AbortController()
  try {
    const reason = await agentLoop(subTab, apiKey, subagentModel, emitToAll, controller.signal, 1, subagentCtx)
    const summary =
      subTab.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks)
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('\n') || "Sorry, I didn't have anything to say."
    if (reason === 'error' || reason === 'truncation_failed') {
      return `Sorry, something went wrong while handling that: ${summary}`
    }
    return summary
  } catch (e) {
    return `Sorry, something went wrong: ${e instanceof Error ? e.message : String(e)}`
  }
}
