import { app } from 'electron'
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { nanoid } from 'nanoid'
import type { ArchivedTabSession, TabSession } from '@shared/types'
import { DEFAULT_MAIN_MODEL } from '@shared/types'
import { sanitizeTabsForPersist, serializeTabForPersist, wasSanitized } from './sanitize'

/** Max number of closed chats kept in history per workspace, oldest dropped first. */
const MAX_HISTORY = 200

function sessionsDir(): string {
  return join(app.getPath('userData'), 'sessions')
}

function slugFor(workspace: string): string {
  return Buffer.from(workspace).toString('base64url')
}

function sessionFile(workspace: string): string {
  return join(sessionsDir(), `${slugFor(workspace)}.json`)
}

function historyFile(workspace: string): string {
  return join(sessionsDir(), `${slugFor(workspace)}.history.json`)
}

/** Assistant tabs are workspace-independent (see TabSession.kind doc comment), so their live
 *  set and archived history live in their own fixed files rather than per-workspace ones. */
function assistantTabsFile(): string {
  return join(sessionsDir(), 'assistant-tabs.json')
}

function assistantHistoryFile(): string {
  return join(sessionsDir(), 'assistant-tabs.history.json')
}

/** Which live-tabs file a debounced persist writes: the open workspace's session file, or the
 *  fixed assistant-tabs file. */
type PersistTarget = 'workspace' | 'assistant'
const PERSIST_TARGETS: readonly PersistTarget[] = ['workspace', 'assistant']

/** Trailing debounce for updateTab-driven writes: an agent step calls updateTab several times in
 *  quick succession, and only the final state of the burst needs to reach disk. */
const PERSIST_DEBOUNCE_MS = 400
/** Upper bound on how long a continuously-updating tab (fast streaming) can go unsaved. */
const PERSIST_MAX_WAIT_MS = 2000
/** Persists slower than this are logged, so regressions in session size/IO show up in logs. */
const SLOW_PERSIST_LOG_MS = 50

// Per-file serialization of async atomic writes. Every write goes through the same `${file}.tmp`
// path, so two overlapping writes of one file would race on the temp file; chaining them makes
// that impossible regardless of which caller (store, history, background helpers) issued them.
const fileWriteChains = new Map<string, Promise<void>>()

/** Writes `content` to `file` atomically: a crash mid-write leaves the previous file intact
 *  instead of a truncated session file, because the rename is the only step that touches it. */
function writeFileAtomic(file: string, content: string): Promise<void> {
  const prev = fileWriteChains.get(file) ?? Promise.resolve()
  const next = prev.then(async () => {
    const tmp = `${file}.tmp`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, file)
  })
  const settled = next.catch(() => undefined)
  fileWriteChains.set(file, settled)
  void settled.then(() => {
    if (fileWriteChains.get(file) === settled) fileWriteChains.delete(file)
  })
  return next
}

/** Synchronous counterpart of writeFileAtomic, for app quit where async work may never finish. */
function writeFileAtomicSync(file: string, content: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

export class SessionStore {
  private tabs: TabSession[] = []
  private history: ArchivedTabSession[] = []
  private assistantHistory: ArchivedTabSession[] = []
  private workspace: string | null = null
  // The model newly-created tabs should start on. Defaults to DEFAULT_MAIN_MODEL until the app
  // has loaded the user's actual settings — main/index.ts calls setDefaultModel(settings.mainModel)
  // right after loadSettings() at startup (before any tab creation happens), and ipc.ts's
  // settingsSet handler keeps it in sync whenever the user changes their default model. Without
  // this, createEmptyTab() would always hardcode DEFAULT_MAIN_MODEL regardless of what the user
  // picked in Settings — see the "code windows default to Claude Sonnet 5" bug this fixes.
  private defaultModel: string = DEFAULT_MAIN_MODEL

  // Per-tab revision, bumped by updateTab. A tab with no entry is at revision 0.
  private tabRevisions = new Map<string, number>()
  // Cached compact JSON per tab, valid while `rev` equals the tab's current revision, so a
  // persist only re-serializes the tabs that actually changed since the last write.
  private serializedTabs = new Map<string, { rev: number; json: string }>()
  // Targets with changes not yet serialized for disk. Cleared at serialization time, which also
  // lets a queued write that was already satisfied (e.g. by flushSync) skip itself.
  private dirtyTargets = new Set<PersistTarget>()
  private persistTimers = new Map<PersistTarget, ReturnType<typeof setTimeout>>()
  // When the oldest un-flushed change for each target was scheduled (drives the max wait).
  private firstDirtyAt = new Map<PersistTarget, number>()
  // Async writes per target are chained so two persists of the same file never run concurrently.
  private writeChains: Record<PersistTarget, Promise<void>> = {
    workspace: Promise.resolve(),
    assistant: Promise.resolve()
  }

  /** The workspace currently loaded in memory (i.e. what the UI is showing right now), or null
   *  if none is open. Used by callers that need to decide whether a given workspace's tabs can
   *  be mutated live (via this store) or must be patched on disk instead — see
   *  deliverScheduledTaskResult in orchestrator.ts. */
  getWorkspace(): string | null {
    return this.workspace
  }

  /** Sets the model id newly-created tabs (createEmptyTab/createTab/createAssistantTab) start
   *  on. Should always be kept equal to the user's current settings.mainModel — see callers in
   *  main/index.ts (startup) and ipc.ts (settingsSet handler). */
  setDefaultModel(model: string): void {
    this.defaultModel = model
  }

  getDefaultModel(): string {
    return this.defaultModel
  }

  /** Loads persisted Assistant tabs + their archived History from their fixed, workspace-
   *  independent files (see assistantTabsFile/assistantHistoryFile). Must be called once at
   *  app startup, BEFORE the first load(workspace) call (or even if no workspace is ever
   *  opened) — load() carries whatever Assistant tabs are already in `this.tabs` across a
   *  workspace switch, so calling this first is what makes Assistant tabs survive an app
   *  restart, not just a live workspace switch. Safe to call multiple times (idempotent
   *  re-read), though in practice it only runs once, at startup. */
  async loadAssistantTabs(): Promise<void> {
    await mkdir(sessionsDir(), { recursive: true })
    try {
      const raw = await readFile(assistantTabsFile(), 'utf8')
      const persisted = sanitizeTabsForPersist((JSON.parse(raw) as TabSession[]).map((t) => ({ totalSavingsUsd: 0, ...t }))).tabs
      const existingIds = new Set(this.tabs.map((t) => t.id))
      for (const t of persisted) if (!existingIds.has(t.id)) this.tabs.push(t)
    } catch {
      // No persisted Assistant tabs yet — nothing to load.
    }
    try {
      const raw = await readFile(assistantHistoryFile(), 'utf8')
      this.assistantHistory = sanitizeTabsForPersist(JSON.parse(raw) as ArchivedTabSession[]).tabs
    } catch {
      this.assistantHistory = []
    }
  }

  async load(workspace: string): Promise<TabSession[]> {
    // Land any debounced writes for the outgoing workspace in the outgoing workspace's file
    // before `this.workspace` / `this.tabs` are switched below.
    await this.flush()
    await mkdir(sessionsDir(), { recursive: true })
    // `needsRepair` drives a one-time rewrite of an already-oversized session file. A single
    // 20 MB binary diff in one tool result once grew this file to 61 MB, which froze the app on
    // its loading screen; clamping on read means such a session opens normally, and the rewrite
    // at the end of this method shrinks the file permanently instead of re-clamping every start.
    let needsRepair = false
    let loaded: TabSession[] | null = null
    try {
      const raw = await readFile(sessionFile(workspace), 'utf8')
      const parsed = (JSON.parse(raw) as TabSession[]).map((t) => ({ totalSavingsUsd: 0, ...t }))
      const { tabs, stats } = sanitizeTabsForPersist(parsed)
      loaded = tabs
      needsRepair = wasSanitized(stats)
      if (needsRepair) {
        console.warn(
          `[session] clamped oversized persisted data for ${workspace}: ${stats.clampedStrings} string(s), ${stats.strippedResults} payload(s)`
        )
      }
    } catch {
      loaded = null
    }
    // Assistant tabs are workspace-independent by design (see TabSession.kind doc comment) —
    // carry any currently-open ones across the switch instead of losing them, since they were
    // never written to the outgoing workspace's session file to begin with (they live in their
    // own fixed file — see assistantTabsFile/persistAssistantTabs).
    const liveAssistantTabs = this.tabs.filter((t) => t.kind === 'assistant')
    // The workspace and its tabs are switched together with no await in between, so a debounced
    // write that fires during the read above still pairs the outgoing workspace with its own tabs.
    this.workspace = workspace
    this.tabs = loaded && loaded.length > 0 ? loaded : [this.createEmptyTab()]
    this.tabs.push(...liveAssistantTabs)
    this.retainTabCaches(new Set(liveAssistantTabs.map((t) => t.id)))

    let historyNeedsRepair = false
    try {
      const raw = await readFile(historyFile(workspace), 'utf8')
      const { tabs, stats } = sanitizeTabsForPersist(JSON.parse(raw) as ArchivedTabSession[])
      this.history = tabs
      historyNeedsRepair = wasSanitized(stats)
    } catch {
      this.history = []
    }

    if (needsRepair) await this.persist()
    if (historyNeedsRepair) await this.persistHistory()
    return this.tabs
  }

  createEmptyTab(): TabSession {
    const now = Date.now()
    return {
      id: nanoid(),
      title: 'Code chat',
      mode: 'agent',
      model: this.defaultModel,
      createdAt: now,
      updatedAt: now,
      messages: [],
      totalCostUsd: 0,
      totalSavingsUsd: 0
    }
  }

  getTabs(): TabSession[] {
    return this.tabs
  }

  getTab(id: string): TabSession | undefined {
    return this.tabs.find((t) => t.id === id)
  }

  async createTab(): Promise<TabSession> {
    const tab = this.createEmptyTab()
    this.tabs.push(tab)
    await this.persist()
    return tab
  }

  /** Creates a brand-new "Assistant" tab (see TabSession.kind doc comment). Every call creates
   *  a distinct tab — there is no create-or-focus singleton behavior. Assistant tabs are
   *  workspace-independent: they're never written to a per-workspace session file, but they ARE
   *  persisted to their own fixed file (see assistantTabsFile) so they survive an app restart,
   *  and archived to their own Assistant History on close (see closeTab()). */
  async createAssistantTab(): Promise<TabSession> {
    const tab = { ...this.createEmptyTab(), kind: 'assistant' as const, title: 'Assistant' }
    this.tabs.push(tab)
    await this.persistAssistantTabs()
    return tab
  }

  /** Closes a tab, archiving it into the appropriate history (unless it never had any
   *  messages). Assistant tabs go to the separate, workspace-independent Assistant History
   *  rather than the per-workspace History. */
  async closeTab(tabId: string): Promise<TabSession[]> {
    const tab = this.tabs.find((t) => t.id === tabId)
    this.tabs = this.tabs.filter((t) => t.id !== tabId)
    this.tabRevisions.delete(tabId)
    this.serializedTabs.delete(tabId)
    if (tab && tab.messages.length > 0) {
      if (tab.kind === 'assistant') {
        this.assistantHistory.unshift({ ...tab, closedAt: Date.now() })
        if (this.assistantHistory.length > MAX_HISTORY) this.assistantHistory.length = MAX_HISTORY
        await this.persistAssistantHistory()
      } else {
        this.history.unshift({ ...tab, closedAt: Date.now() })
        if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY
        await this.persistHistory()
      }
    }
    if (tab?.kind === 'assistant') await this.persistAssistantTabs()
    if (this.tabs.filter((t) => t.kind !== 'assistant').length === 0) this.tabs.push(this.createEmptyTab())
    await this.persist()
    return this.tabs
  }

  /** Replaces the in-memory tab and schedules a debounced, coalesced write of its file.
   *  Deliberately does NOT wait for the disk write: the orchestrator calls this several times
   *  per agent step, and serializing + writing a long transcript synchronously each time blocked
   *  the main process (and with it the UI). The returned promise resolves once memory is
   *  updated; callers that need the data durably on disk (tests, app quit) must call flush()
   *  or flushSync(). */
  async updateTab(tab: TabSession): Promise<void> {
    const idx = this.tabs.findIndex((t) => t.id === tab.id)
    if (idx >= 0) {
      tab.updatedAt = Date.now()
      this.tabs[idx] = tab
      this.tabRevisions.set(tab.id, (this.tabRevisions.get(tab.id) ?? 0) + 1)
      this.schedulePersist(tab.kind === 'assistant' ? 'assistant' : 'workspace')
    }
  }

  /** Cancels pending debounce timers and writes every pending change now, resolving once all
   *  writes (including any already in flight) have landed. Failures are logged, not thrown,
   *  so a disk error cannot block a workspace switch. */
  async flush(): Promise<void> {
    await Promise.all(
      PERSIST_TARGETS.map(async (target) => {
        try {
          if (this.dirtyTargets.has(target)) await this.runPersist(target)
          else await this.writeChains[target]
        } catch (err) {
          console.error(`[session] flush of ${target} tabs failed:`, err)
        }
      })
    )
  }

  /** Synchronous flush for app quit, where pending async work may never get to run. */
  flushSync(): void {
    for (const target of PERSIST_TARGETS) {
      this.cancelScheduled(target)
      try {
        this.writeTargetSync(target)
      } catch (err) {
        console.error(`[session] sync flush of ${target} tabs failed:`, err)
      }
    }
  }

  getHistory(): ArchivedTabSession[] {
    return this.history
  }

  /** Removes an archived chat permanently. */
  async deleteHistoryEntry(tabId: string): Promise<ArchivedTabSession[]> {
    this.history = this.history.filter((t) => t.id !== tabId)
    await this.persistHistory()
    return this.history
  }

  /** Restores an archived chat as a new live tab (keeps its messages/title, gets a fresh id). */
  async reopenHistoryEntry(tabId: string): Promise<TabSession | null> {
    const archived = this.history.find((t) => t.id === tabId)
    if (!archived) return null
    const now = Date.now()
    const { closedAt: _closedAt, ...rest } = archived
    const tab: TabSession = { ...rest, id: nanoid(), updatedAt: now }
    this.tabs.push(tab)
    this.history = this.history.filter((t) => t.id !== tabId)
    await Promise.all([this.persist(), this.persistHistory()])
    return tab
  }

  getAssistantHistory(): ArchivedTabSession[] {
    return this.assistantHistory
  }

  /** Removes an archived Assistant tab permanently. */
  async deleteAssistantHistoryEntry(tabId: string): Promise<ArchivedTabSession[]> {
    this.assistantHistory = this.assistantHistory.filter((t) => t.id !== tabId)
    await this.persistAssistantHistory()
    return this.assistantHistory
  }

  /** Restores an archived Assistant tab as a new live tab (fresh id, keeps messages/title). */
  async reopenAssistantHistoryEntry(tabId: string): Promise<TabSession | null> {
    const archived = this.assistantHistory.find((t) => t.id === tabId)
    if (!archived) return null
    const now = Date.now()
    const { closedAt: _closedAt, ...rest } = archived
    const tab: TabSession = { ...rest, id: nanoid(), updatedAt: now }
    this.tabs.push(tab)
    this.assistantHistory = this.assistantHistory.filter((t) => t.id !== tabId)
    await Promise.all([this.persistAssistantTabs(), this.persistAssistantHistory()])
    return tab
  }

  /** Immediate write of the workspace session file; also satisfies any pending debounced one. */
  private persist(): Promise<void> {
    return this.runPersist('workspace')
  }

  private async persistHistory(): Promise<void> {
    if (!this.workspace) return
    await mkdir(sessionsDir(), { recursive: true })
    await writeFileAtomic(historyFile(this.workspace), JSON.stringify(sanitizeTabsForPersist(this.history).tabs))
  }

  /** Immediate write of the assistant-tabs file; also satisfies any pending debounced one. */
  private persistAssistantTabs(): Promise<void> {
    return this.runPersist('assistant')
  }

  private async persistAssistantHistory(): Promise<void> {
    await mkdir(sessionsDir(), { recursive: true })
    await writeFileAtomic(assistantHistoryFile(), JSON.stringify(sanitizeTabsForPersist(this.assistantHistory).tabs))
  }

  /** Drops revision/serialization cache entries for every tab id not in `keep`. */
  private retainTabCaches(keep: Set<string>): void {
    for (const id of this.tabRevisions.keys()) if (!keep.has(id)) this.tabRevisions.delete(id)
    for (const id of this.serializedTabs.keys()) if (!keep.has(id)) this.serializedTabs.delete(id)
  }

  private schedulePersist(target: PersistTarget): void {
    const now = Date.now()
    this.dirtyTargets.add(target)
    let first = this.firstDirtyAt.get(target)
    if (first === undefined) {
      first = now
      this.firstDirtyAt.set(target, now)
    }
    const existing = this.persistTimers.get(target)
    if (existing) clearTimeout(existing)
    const delay = Math.max(0, Math.min(PERSIST_DEBOUNCE_MS, first + PERSIST_MAX_WAIT_MS - now))
    this.persistTimers.set(
      target,
      setTimeout(() => {
        this.persistTimers.delete(target)
        this.runPersist(target).catch((err) => console.error(`[session] persist of ${target} tabs failed:`, err))
      }, delay)
    )
  }

  private cancelScheduled(target: PersistTarget): void {
    const timer = this.persistTimers.get(target)
    if (timer) clearTimeout(timer)
    this.persistTimers.delete(target)
    this.firstDirtyAt.delete(target)
  }

  /** Cancels any pending timer for `target` and queues a write on its chain. The content is
   *  serialized when the write actually starts, so it always reflects the latest state. */
  private runPersist(target: PersistTarget): Promise<void> {
    this.cancelScheduled(target)
    this.dirtyTargets.add(target)
    const run = this.writeChains[target].then(() => this.writeTarget(target))
    this.writeChains[target] = run.catch(() => undefined)
    return run
  }

  private targetFile(target: PersistTarget): string | null {
    if (target === 'assistant') return assistantTabsFile()
    return this.workspace ? sessionFile(this.workspace) : null
  }

  /** Builds the file content from cached per-tab JSON, re-serializing only tabs whose revision
   *  changed. Assistant-kind tabs live in their own fixed file, never the per-workspace session
   *  file. Size-bounded on the way out (see ./sanitize.ts). Pure — the live in-memory tabs keep
   *  their full, byte-exact content, because that is what feeds toORMessages() on the next turn. */
  private buildTargetContent(target: PersistTarget): { content: string; reSerialized: number; total: number } {
    const tabs = this.tabs.filter((t) => (target === 'assistant' ? t.kind === 'assistant' : t.kind !== 'assistant'))
    let reSerialized = 0
    const parts = tabs.map((t) => {
      const rev = this.tabRevisions.get(t.id) ?? 0
      const cached = this.serializedTabs.get(t.id)
      if (cached && cached.rev === rev) return cached.json
      const { json } = serializeTabForPersist(t)
      this.serializedTabs.set(t.id, { rev, json })
      reSerialized++
      return json
    })
    return { content: '[' + parts.join(',') + ']', reSerialized, total: tabs.length }
  }

  private logSlowPersist(target: PersistTarget, startedAt: number, built: { content: string; reSerialized: number; total: number }): void {
    const ms = Math.round(performance.now() - startedAt)
    if (ms < SLOW_PERSIST_LOG_MS) return
    const bytes = Buffer.byteLength(built.content, 'utf8')
    console.log(`[perf] session persist ${target} ${ms}ms ${bytes} bytes ${built.reSerialized}/${built.total} tabs re-serialized`)
  }

  private async writeTarget(target: PersistTarget): Promise<void> {
    // Already satisfied by an earlier queued write or flushSync, with no changes since.
    if (!this.dirtyTargets.has(target)) return
    this.dirtyTargets.delete(target)
    const file = this.targetFile(target)
    if (!file) return
    const startedAt = performance.now()
    try {
      const built = this.buildTargetContent(target)
      await mkdir(sessionsDir(), { recursive: true })
      await writeFileAtomic(file, built.content)
      this.logSlowPersist(target, startedAt, built)
    } catch (err) {
      // Keep the change pending so the next flush/update retries it.
      this.dirtyTargets.add(target)
      throw err
    }
  }

  private writeTargetSync(target: PersistTarget): void {
    if (!this.dirtyTargets.has(target)) return
    this.dirtyTargets.delete(target)
    const file = this.targetFile(target)
    if (!file) return
    const startedAt = performance.now()
    try {
      const built = this.buildTargetContent(target)
      mkdirSync(sessionsDir(), { recursive: true })
      writeFileAtomicSync(file, built.content)
      this.logSlowPersist(target, startedAt, built)
    } catch (err) {
      this.dirtyTargets.add(target)
      throw err
    }
  }
}

export const sessionStore = new SessionStore()

// ---------- Background-workspace file helpers ----------
//
// The SessionStore singleton above only ever holds ONE workspace's tabs/history in memory at a
// time (whatever the UI currently has open). A scheduled task can fire for a *different*
// workspace than the one the user has open right now, so delivering its result there can't go
// through the live in-memory store (that would corrupt the currently-open workspace's state).
// These standalone helpers read/write a given workspace's session+history files directly,
// independent of whatever SessionStore.workspace currently is. They intentionally duplicate the
// tiny amount of file-format logic above rather than refactor the class, to keep the live path
// (used on every turn) untouched.

async function readWorkspaceTabs(workspace: string): Promise<TabSession[]> {
  try {
    const raw = await readFile(sessionFile(workspace), 'utf8')
    return JSON.parse(raw) as TabSession[]
  } catch {
    return []
  }
}

async function writeWorkspaceTabs(workspace: string, tabs: TabSession[]): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFileAtomic(sessionFile(workspace), JSON.stringify(sanitizeTabsForPersist(tabs).tabs))
}

async function readWorkspaceHistory(workspace: string): Promise<ArchivedTabSession[]> {
  try {
    const raw = await readFile(historyFile(workspace), 'utf8')
    return JSON.parse(raw) as ArchivedTabSession[]
  } catch {
    return []
  }
}

async function writeWorkspaceHistory(workspace: string, history: ArchivedTabSession[]): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFileAtomic(historyFile(workspace), JSON.stringify(sanitizeTabsForPersist(history).tabs))
}

/** Appends `message` to the given tab, wherever it lives in `workspace`'s persisted state:
 *  - if `tabId` matches a live (non-archived) tab, appends to it in place;
 *  - else if it matches an archived (History) entry, restores it as a live tab (fresh id, like
 *    reopenHistoryEntry) and appends to it, removing it from history;
 *  - else (not found anywhere, or `tabId` is null) creates a brand-new tab titled
 *    `fallbackTitle`/`fallbackKind` and appends to it.
 *  Operates purely on disk — does NOT touch the live SessionStore singleton, so it is safe to
 *  call for a workspace the user doesn't currently have open. Returns the id of the tab the
 *  message actually landed in. */
export async function appendMessageToWorkspaceTab(
  workspace: string,
  tabId: string | null,
  message: TabSession['messages'][number],
  fallbackTitle: string,
  fallbackModel: string = sessionStore.getDefaultModel()
): Promise<string> {
  const tabs = await readWorkspaceTabs(workspace)
  const idx = tabId ? tabs.findIndex((t) => t.id === tabId) : -1
  if (idx >= 0) {
    tabs[idx] = { ...tabs[idx], messages: [...tabs[idx].messages, message], updatedAt: Date.now() }
    await writeWorkspaceTabs(workspace, tabs)
    return tabs[idx].id
  }

  if (tabId) {
    const history = await readWorkspaceHistory(workspace)
    const archivedIdx = history.findIndex((t) => t.id === tabId)
    if (archivedIdx >= 0) {
      const { closedAt: _closedAt, ...rest } = history[archivedIdx]
      const restored: TabSession = { ...rest, id: nanoid(), messages: [...rest.messages, message], updatedAt: Date.now() }
      tabs.push(restored)
      history.splice(archivedIdx, 1)
      await Promise.all([writeWorkspaceTabs(workspace, tabs), writeWorkspaceHistory(workspace, history)])
      return restored.id
    }
  }

  const now = Date.now()
  const created: TabSession = {
    id: nanoid(),
    title: fallbackTitle,
    mode: 'agent',
    model: fallbackModel,
    createdAt: now,
    updatedAt: now,
    messages: [message],
    totalCostUsd: 0,
    totalSavingsUsd: 0,
    kind: 'project'
  }
  tabs.push(created)
  await writeWorkspaceTabs(workspace, tabs)
  return created.id
}
