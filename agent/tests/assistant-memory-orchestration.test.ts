import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import './testElectronMock'
import { electronMockState } from './testElectronMock'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMemoryPool } from '../shared/types'

const {
  listAssistantMemory,
  deleteAssistantMemorySlot,
  clearAssistantMemoryRollup,
  clearAllAssistantMemory,
  buildAssistantMemoryDigestForTab,
  buildFullAssistantMemoryDigest
} = await import('../src/main/agent/memory/assistantMemory')

const tempDirs: string[] = []

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'klenny-assistant-memory-test-'))
  tempDirs.push(dir)
  electronMockState.userDataDir = dir
})

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

function poolFilePath(): string {
  return join(electronMockState.userDataDir, 'sessions', 'assistant-memory.json')
}

async function seedPool(pool: AssistantMemoryPool): Promise<void> {
  await mkdir(join(electronMockState.userDataDir, 'sessions'), { recursive: true })
  await writeFile(poolFilePath(), JSON.stringify(pool, null, 2), 'utf8')
}

async function setAssistantMemorySize(size: 10000 | 20000 | 'disabled'): Promise<void> {
  await mkdir(electronMockState.userDataDir, { recursive: true })
  await writeFile(join(electronMockState.userDataDir, 'settings.json'), JSON.stringify({ assistantMemorySize: size }), 'utf8')
}

const slotA = {
  tabId: 'tab-a',
  tabTitle: 'Email triage',
  content: 'Checked inbox, replied to one message.',
  updatedAt: Date.now() - 5 * 60_000,
  tokenEstimate: 20,
  lastMemorizedMessageId: 'm1'
}

const slotB = {
  tabId: 'tab-b',
  tabTitle: 'Research task',
  content: 'Still gathering sources on topic X.',
  updatedAt: Date.now() - 60_000,
  tokenEstimate: 30,
  lastMemorizedMessageId: 'm2'
}

describe('listAssistantMemory', () => {
  test('returns an empty pool when nothing has been written yet', async () => {
    const pool = await listAssistantMemory()
    expect(pool.slots).toEqual([])
    expect(pool.rollup).toBeNull()
  })

  test('returns the persisted pool from disk', async () => {
    await seedPool({ slots: [slotA, slotB], rollup: null })
    const pool = await listAssistantMemory()
    expect(pool.slots).toHaveLength(2)
    expect(pool.slots.map((s) => s.tabId).sort()).toEqual(['tab-a', 'tab-b'])
  })
})

describe('deleteAssistantMemorySlot', () => {
  test('removes only the targeted slot and persists the change', async () => {
    await seedPool({ slots: [slotA, slotB], rollup: null })
    const result = await deleteAssistantMemorySlot('tab-a')
    expect(result.slots.map((s) => s.tabId)).toEqual(['tab-b'])

    // Re-read independently to confirm the write actually landed on disk, not just in memory.
    const reloaded = await listAssistantMemory()
    expect(reloaded.slots.map((s) => s.tabId)).toEqual(['tab-b'])
  })

  test('is a no-op (no throw) when the tabId is not present', async () => {
    await seedPool({ slots: [slotA], rollup: null })
    const result = await deleteAssistantMemorySlot('does-not-exist')
    expect(result.slots.map((s) => s.tabId)).toEqual(['tab-a'])
  })
})

describe('clearAssistantMemoryRollup', () => {
  test('clears the rollup but leaves slots untouched', async () => {
    const rollup = { content: 'old stuff', updatedAt: Date.now(), tokenEstimate: 10 }
    await seedPool({ slots: [slotA], rollup })
    const result = await clearAssistantMemoryRollup()
    expect(result.rollup).toBeNull()
    expect(result.slots).toHaveLength(1)
  })
})

describe('clearAllAssistantMemory', () => {
  test('wipes both slots and rollup', async () => {
    const rollup = { content: 'old stuff', updatedAt: Date.now(), tokenEstimate: 10 }
    await seedPool({ slots: [slotA, slotB], rollup })
    const result = await clearAllAssistantMemory()
    expect(result.slots).toEqual([])
    expect(result.rollup).toBeNull()

    const reloaded = await listAssistantMemory()
    expect(reloaded.slots).toEqual([])
    expect(reloaded.rollup).toBeNull()
  })
})

describe('buildFullAssistantMemoryDigest', () => {
  test('returns "" when the setting is disabled, even with slots present', async () => {
    await setAssistantMemorySize('disabled')
    await seedPool({ slots: [slotA], rollup: null })
    const digest = await buildFullAssistantMemoryDigest()
    expect(digest).toBe('')
  })

  test('returns "" for an empty pool when enabled', async () => {
    await setAssistantMemorySize(10000)
    const digest = await buildFullAssistantMemoryDigest()
    expect(digest).toBe('')
  })

  test('includes every slot with no exclusion', async () => {
    await setAssistantMemorySize(10000)
    await seedPool({ slots: [slotA, slotB], rollup: null })
    const digest = await buildFullAssistantMemoryDigest()
    expect(digest).toContain('Email triage')
    expect(digest).toContain('Research task')
  })
})

describe('buildAssistantMemoryDigestForTab', () => {
  test('returns "" when the setting is disabled', async () => {
    await setAssistantMemorySize('disabled')
    await seedPool({ slots: [slotA, slotB], rollup: null })
    const digest = await buildAssistantMemoryDigestForTab('tab-a')
    expect(digest).toBe('')
  })

  test("excludes the requesting tab's own slot", async () => {
    await setAssistantMemorySize(10000)
    await seedPool({ slots: [slotA, slotB], rollup: null })
    const digest = await buildAssistantMemoryDigestForTab('tab-a')
    expect(digest).not.toContain('Email triage')
    expect(digest).toContain('Research task')
  })

  test('returns "" when the only slot present belongs to the requesting tab', async () => {
    await setAssistantMemorySize(10000)
    await seedPool({ slots: [slotA], rollup: null })
    const digest = await buildAssistantMemoryDigestForTab('tab-a')
    expect(digest).toBe('')
  })
})

describe('pool mutex serialization', () => {
  test('concurrent delete calls against different slots both land without clobbering each other', async () => {
    await seedPool({ slots: [slotA, slotB], rollup: null })
    await Promise.all([deleteAssistantMemorySlot('tab-a'), deleteAssistantMemorySlot('tab-b')])
    const pool = await listAssistantMemory()
    expect(pool.slots).toEqual([])
  })

  test('the on-disk file is always valid JSON after interleaved writes (no partial-write corruption)', async () => {
    await seedPool({ slots: [slotA, slotB], rollup: null })
    await Promise.all([
      deleteAssistantMemorySlot('tab-a'),
      clearAssistantMemoryRollup(),
      listAssistantMemory()
    ])
    const raw = await readFile(poolFilePath(), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
