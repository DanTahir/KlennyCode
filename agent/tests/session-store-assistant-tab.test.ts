import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import './testElectronMock'
import { electronMockState } from './testElectronMock'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { SessionStore } = await import('../src/main/session/store')

const tempDirs: string[] = []

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'klenny-session-store-test-'))
  tempDirs.push(dir)
  electronMockState.userDataDir = dir
})

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

function slugFor(workspace: string): string {
  return Buffer.from(workspace).toString('base64url')
}

function assistantTabsFile(): string {
  return join(electronMockState.userDataDir, 'sessions', 'assistant-tabs.json')
}

function assistantHistoryFile(): string {
  return join(electronMockState.userDataDir, 'sessions', 'assistant-tabs.history.json')
}

describe('SessionStore default model (new tabs should honor settings.mainModel, not a hardcoded id)', () => {
  test('createEmptyTab() uses DEFAULT_MAIN_MODEL before setDefaultModel() is ever called', async () => {
    const { DEFAULT_MAIN_MODEL } = await import('../shared/types')
    const store = new SessionStore()
    const tab = store.createEmptyTab()
    expect(tab.model).toBe(DEFAULT_MAIN_MODEL)
  })

  test('setDefaultModel() changes what createEmptyTab()/createTab() hand out afterward', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/model-a')
    store.setDefaultModel('openai/gpt-5.5')

    expect(store.createEmptyTab().model).toBe('openai/gpt-5.5')
    const tab = await store.createTab()
    expect(tab.model).toBe('openai/gpt-5.5')
  })

  test('setDefaultModel() also applies to createAssistantTab()', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/model-b')
    store.setDefaultModel('google/gemini-3-pro')

    const tab = await store.createAssistantTab()
    expect(tab.model).toBe('google/gemini-3-pro')
  })

  test('getDefaultModel() reflects the most recent setDefaultModel() call', async () => {
    const store = new SessionStore()
    store.setDefaultModel('anthropic/claude-opus-5')
    expect(store.getDefaultModel()).toBe('anthropic/claude-opus-5')
    store.setDefaultModel('openai/gpt-5.5')
    expect(store.getDefaultModel()).toBe('openai/gpt-5.5')
  })

  test('an auto-recreated tab (after closing the last live tab) also honors the current default model', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/model-c')
    store.setDefaultModel('openai/gpt-5.5')
    const onlyTab = store.getTabs()[0]

    await store.closeTab(onlyTab.id)

    expect(store.getTabs()).toHaveLength(1)
    expect(store.getTabs()[0].model).toBe('openai/gpt-5.5')
  })
})

describe('SessionStore Assistant tabs (workspace-independent, persisted)', () => {
  test('createAssistantTab() adds an in-memory tab with kind "assistant"', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = await store.createAssistantTab()
    expect(tab.kind).toBe('assistant')
    expect(store.getTabs().some((t) => t.id === tab.id)).toBe(true)
  })

  test('an Assistant tab is never written to the per-workspace session file on disk', async () => {
    const store = new SessionStore()
    const workspace = '/fake/workspace/a'
    await store.load(workspace)
    // createTab() persists (forcing the session file to exist); createAssistantTab() must not
    // add itself to that file.
    await store.createTab()
    await store.createAssistantTab()

    const sessionFile = join(electronMockState.userDataDir, 'sessions', `${slugFor(workspace)}.json`)
    const raw = await readFile(sessionFile, 'utf8')
    const persisted = JSON.parse(raw) as Array<{ kind?: string }>
    expect(persisted.every((t) => t.kind !== 'assistant')).toBe(true)
  })

  test('createAssistantTab() persists the tab to the fixed assistant-tabs file', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = await store.createAssistantTab()

    const raw = await readFile(assistantTabsFile(), 'utf8')
    const persisted = JSON.parse(raw) as Array<{ id: string; kind?: string }>
    expect(persisted.find((t) => t.id === tab.id)?.kind).toBe('assistant')
  })

  test('closing an Assistant tab with messages archives it to Assistant History, not the per-workspace History', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = await store.createAssistantTab()
    tab.messages.push({
      id: 'm1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now()
    } as never)

    await store.closeTab(tab.id)
    expect(store.getHistory().find((h) => h.id === tab.id)).toBeUndefined()
    expect(store.getAssistantHistory().find((h) => h.id === tab.id)).toBeDefined()
  })

  test('closing an Assistant tab with no messages archives nothing', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = await store.createAssistantTab()
    await store.closeTab(tab.id)
    expect(store.getAssistantHistory().find((h) => h.id === tab.id)).toBeUndefined()
  })

  test('closing a normal project tab with messages still archives it to History (regression check)', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = await store.createTab()
    tab.messages.push({
      id: 'm1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now()
    } as never)
    await store.updateTab(tab)

    await store.closeTab(tab.id)
    expect(store.getHistory().find((h) => h.id === tab.id)).toBeDefined()
  })

  test('switching workspaces (load()) carries live Assistant tabs across instead of losing them', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const assistantTab = await store.createAssistantTab()

    await store.load('/fake/workspace/b')
    expect(store.getTabs().some((t) => t.id === assistantTab.id)).toBe(true)
  })

  test('updateTab() on an Assistant tab writes to the assistant-tabs file, not the workspace session file', async () => {
    const store = new SessionStore()
    const workspace = '/fake/workspace/a'
    await store.load(workspace)
    // Force the session file to exist first via a real project tab.
    await store.createTab()
    const tab = await store.createAssistantTab()
    tab.title = 'Updated title'
    await store.updateTab(tab)

    const sessionFile = join(electronMockState.userDataDir, 'sessions', `${slugFor(workspace)}.json`)
    const raw = await readFile(sessionFile, 'utf8')
    const persisted = JSON.parse(raw) as Array<{ id: string }>
    expect(persisted.find((t) => t.id === tab.id)).toBeUndefined()

    const assistantRaw = await readFile(assistantTabsFile(), 'utf8')
    const assistantPersisted = JSON.parse(assistantRaw) as Array<{ id: string; title: string }>
    expect(assistantPersisted.find((t) => t.id === tab.id)?.title).toBe('Updated title')
  })

  test('loadAssistantTabs() restores persisted Assistant tabs across a fresh SessionStore instance (simulated app restart)', async () => {
    const store1 = new SessionStore()
    await store1.load('/fake/workspace/a')
    const tab = await store1.createAssistantTab()
    tab.title = 'Reminder chat'
    await store1.updateTab(tab)

    // Simulate an app restart: brand-new SessionStore instance, load assistant tabs before any
    // workspace load, exactly like main/index.ts does at startup.
    const store2 = new SessionStore()
    await store2.loadAssistantTabs()
    expect(store2.getTabs().some((t) => t.id === tab.id && t.title === 'Reminder chat')).toBe(true)
  })

  test('loadAssistantTabs() also restores Assistant History across a restart', async () => {
    const store1 = new SessionStore()
    await store1.load('/fake/workspace/a')
    const tab = await store1.createAssistantTab()
    tab.messages.push({
      id: 'm1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now()
    } as never)
    await store1.closeTab(tab.id)

    const store2 = new SessionStore()
    await store2.loadAssistantTabs()
    expect(store2.getAssistantHistory().find((h) => h.id === tab.id)).toBeDefined()
  })

  test('reopenAssistantHistoryEntry() restores an archived Assistant tab as a live tab with a fresh id', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = await store.createAssistantTab()
    tab.title = 'Old assistant chat'
    tab.messages.push({
      id: 'm1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now()
    } as never)
    await store.closeTab(tab.id)

    const reopened = await store.reopenAssistantHistoryEntry(tab.id)
    expect(reopened).not.toBeNull()
    expect(reopened?.id).not.toBe(tab.id)
    expect(reopened?.title).toBe('Old assistant chat')
    expect(store.getAssistantHistory().find((h) => h.id === tab.id)).toBeUndefined()
  })

  test('deleteAssistantHistoryEntry() removes an archived Assistant tab permanently', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = await store.createAssistantTab()
    tab.messages.push({
      id: 'm1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now()
    } as never)
    await store.closeTab(tab.id)

    await store.deleteAssistantHistoryEntry(tab.id)
    expect(store.getAssistantHistory().find((h) => h.id === tab.id)).toBeUndefined()

    const raw = await readFile(assistantHistoryFile(), 'utf8')
    const persisted = JSON.parse(raw) as Array<{ id: string }>
    expect(persisted.find((t) => t.id === tab.id)).toBeUndefined()
  })
})
