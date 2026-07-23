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

describe('SessionStore ephemeral Assistant tabs', () => {
  test('createAssistantTab() adds an in-memory tab with kind "assistant"', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = store.createAssistantTab()
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
    store.createAssistantTab()

    const sessionFile = join(electronMockState.userDataDir, 'sessions', `${slugFor(workspace)}.json`)
    const raw = await readFile(sessionFile, 'utf8')
    const persisted = JSON.parse(raw) as Array<{ kind?: string }>
    expect(persisted.every((t) => t.kind !== 'assistant')).toBe(true)
  })

  test('closing an Assistant tab does not archive it to History, even with messages', async () => {
    const store = new SessionStore()
    await store.load('/fake/workspace/a')
    const tab = store.createAssistantTab()
    tab.messages.push({
      id: 'm1',
      role: 'user',
      blocks: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now()
    } as never)

    await store.closeTab(tab.id)
    expect(store.getHistory().find((h) => h.id === tab.id)).toBeUndefined()
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
    const assistantTab = store.createAssistantTab()

    await store.load('/fake/workspace/b')
    expect(store.getTabs().some((t) => t.id === assistantTab.id)).toBe(true)
  })

  test('updateTab() on an Assistant tab does not trigger a disk write', async () => {
    const store = new SessionStore()
    const workspace = '/fake/workspace/a'
    await store.load(workspace)
    // Force the session file to exist first via a real project tab.
    await store.createTab()
    const tab = store.createAssistantTab()
    tab.title = 'Updated title'
    await store.updateTab(tab)

    const sessionFile = join(electronMockState.userDataDir, 'sessions', `${slugFor(workspace)}.json`)
    const raw = await readFile(sessionFile, 'utf8')
    const persisted = JSON.parse(raw) as Array<{ id: string }>
    expect(persisted.find((t) => t.id === tab.id)).toBeUndefined()
  })
})
