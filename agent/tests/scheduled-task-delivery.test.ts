import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import './testElectronMock'
import { electronMockState } from './testElectronMock'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArchivedTabSession, ChatMessage, TabSession } from '../shared/types'

const { appendMessageToWorkspaceTab } = await import('../src/main/session/store')

const tempDirs: string[] = []

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'klenny-sched-delivery-test-'))
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

function sessionsDir(): string {
  return join(electronMockState.userDataDir, 'sessions')
}

function makeTab(id: string, overrides: Partial<TabSession> = {}): TabSession {
  return {
    id,
    title: 'Existing tab',
    mode: 'agent',
    model: 'anthropic/claude-sonnet-5',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    totalCostUsd: 0,
    totalSavingsUsd: 0,
    ...overrides
  }
}

function makeMessage(): ChatMessage {
  return {
    id: 'msg1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'Scheduled task result' }],
    createdAt: Date.now()
  }
}

async function writeWorkspaceTabsFile(workspace: string, tabs: TabSession[]): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(join(sessionsDir(), `${slugFor(workspace)}.json`), JSON.stringify(tabs, null, 2), 'utf8')
}

async function writeWorkspaceHistoryFile(workspace: string, history: ArchivedTabSession[]): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(join(sessionsDir(), `${slugFor(workspace)}.history.json`), JSON.stringify(history, null, 2), 'utf8')
}

async function readWorkspaceTabsFile(workspace: string): Promise<TabSession[]> {
  const raw = await readFile(join(sessionsDir(), `${slugFor(workspace)}.json`), 'utf8')
  return JSON.parse(raw) as TabSession[]
}

async function readWorkspaceHistoryFile(workspace: string): Promise<ArchivedTabSession[]> {
  const raw = await readFile(join(sessionsDir(), `${slugFor(workspace)}.history.json`), 'utf8')
  return JSON.parse(raw) as ArchivedTabSession[]
}

describe('appendMessageToWorkspaceTab (background-workspace scheduled task delivery)', () => {
  test('appends to a live tab that still exists in the workspace session file', async () => {
    const workspace = '/fake/project/a'
    const tab = makeTab('tab1', { messages: [{ id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'hi' }], createdAt: Date.now() }] })
    await writeWorkspaceTabsFile(workspace, [tab])

    const message = makeMessage()
    const resultId = await appendMessageToWorkspaceTab(workspace, 'tab1', message, 'Scheduled: fallback')

    expect(resultId).toBe('tab1')
    const tabs = await readWorkspaceTabsFile(workspace)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].messages).toHaveLength(2)
    expect(tabs[0].messages[1].id).toBe('msg1')
  })

  test('restores a tab from history and appends to it, removing it from history', async () => {
    const workspace = '/fake/project/b'
    await writeWorkspaceTabsFile(workspace, [])
    const archived: ArchivedTabSession = { ...makeTab('tab2'), closedAt: Date.now() }
    await writeWorkspaceHistoryFile(workspace, [archived])

    const message = makeMessage()
    const resultId = await appendMessageToWorkspaceTab(workspace, 'tab2', message, 'Scheduled: fallback')

    // Reopening mints a fresh id (matches sessionStore.reopenHistoryEntry's existing behavior).
    expect(resultId).not.toBe('tab2')

    const tabs = await readWorkspaceTabsFile(workspace)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe(resultId)
    expect(tabs[0].messages).toHaveLength(1)
    expect(tabs[0].messages[0].id).toBe('msg1')

    const history = await readWorkspaceHistoryFile(workspace)
    expect(history).toHaveLength(0)
  })

  test('creates a brand-new tab when the creator tab is not found anywhere', async () => {
    const workspace = '/fake/project/c'
    await writeWorkspaceTabsFile(workspace, [])
    await writeWorkspaceHistoryFile(workspace, [])

    const message = makeMessage()
    const resultId = await appendMessageToWorkspaceTab(workspace, 'does-not-exist', message, 'Scheduled: My Task')

    const tabs = await readWorkspaceTabsFile(workspace)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe(resultId)
    expect(tabs[0].title).toBe('Scheduled: My Task')
    expect(tabs[0].messages).toHaveLength(1)
  })

  test('creates a brand-new tab when creatorTabId is null (no session file exists yet)', async () => {
    const workspace = '/fake/project/d'
    const message = makeMessage()
    const resultId = await appendMessageToWorkspaceTab(workspace, null, message, 'Scheduled: Untied Task')

    const tabs = await readWorkspaceTabsFile(workspace)
    expect(tabs).toHaveLength(1)
    expect(tabs[0].id).toBe(resultId)
    expect(tabs[0].title).toBe('Scheduled: Untied Task')
  })

  test('never touches a different workspace file', async () => {
    const workspaceA = '/fake/project/e'
    const workspaceB = '/fake/project/f'
    await writeWorkspaceTabsFile(workspaceA, [makeTab('shared-id')])
    await writeWorkspaceTabsFile(workspaceB, [makeTab('shared-id')])

    await appendMessageToWorkspaceTab(workspaceA, 'shared-id', makeMessage(), 'fallback')

    const tabsA = await readWorkspaceTabsFile(workspaceA)
    const tabsB = await readWorkspaceTabsFile(workspaceB)
    expect(tabsA[0].messages).toHaveLength(1)
    expect(tabsB[0].messages).toHaveLength(0)
  })
})
