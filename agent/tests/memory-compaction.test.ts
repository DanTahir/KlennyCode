import { describe, expect, test, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelInfo } from '@shared/types'

// This file exercises 'global' scope (~/.klenny) — see testHomeMock.ts for why the shared
// node:os home mock (not a locally-declared one) must be used.
import { homeMockState } from './testHomeMock'
import { electronMockState } from './testElectronMock' // registers the shared electron mock before workspace.ts (imports electron) loads anywhere

// Track calls made to the mocked utility-prompt runner so tests can assert on how many passes
// happened and what was actually sent, without hitting the real OpenRouter API.
let promptCalls: Array<{ systemPrompt: string; userContent: string; maxTokens?: number }> = []
let promptResponder: (userContent: string) => string = (userContent) => userContent

mock.module('../src/main/openrouter/client', () => ({
  runUtilityPrompt: async (opts: { systemPrompt: string; userContent: string; maxTokens?: number }) => {
    promptCalls.push(opts)
    return promptResponder(opts.userContent)
  }
}))

const baseModel: ModelInfo = {
  id: 'test/utility-model',
  name: 'Test Utility Model',
  contextLength: 128_000,
  promptPrice: 0,
  completionPrice: 0,
  cacheReadPrice: null,
  cacheWritePrice: null,
  supportsExplicitCaching: false,
  supportsTools: true,
  supportsReasoning: false,
  supportsVision: false,
  supportsEmbeddings: false,
  maxCompletionTokens: 8_000
}

let workspaceDir: string

let fakeHomeDir: string

beforeAll(async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'klenny-userdata-memcompact-'))
  workspaceDir = await mkdtemp(join(tmpdir(), 'klenny-memcompact-'))
  fakeHomeDir = await mkdtemp(join(tmpdir(), 'klenny-fakehome-memcompact-'))
  homeMockState.homeDir = fakeHomeDir
  electronMockState.userDataDir = userDataDir

  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(workspaceDir)
})

afterAll(async () => {
  const { setWorkspace } = await import('../src/main/workspace')
  setWorkspace(null)
  await rm(workspaceDir, { recursive: true, force: true })
  await rm(fakeHomeDir, { recursive: true, force: true })
})

beforeEach(() => {
  promptCalls = []
  promptResponder = (userContent) => userContent
})

describe('computePassCharBudget', () => {
  test('is bounded by 3x the model max output tokens when that is the tightest constraint', async () => {
    const { computePassCharBudget } = await import('../src/main/agent/memory/compaction')
    const model: ModelInfo = { ...baseModel, contextLength: 1_000_000, maxCompletionTokens: 4_000 }
    const budget = computePassCharBudget(model)
    // 4000 * 3 = 12000 tokens * 4 chars/token = 48000 chars — should be the binding constraint,
    // far below both the 500k hard cap and the context-window-driven ceiling.
    expect(budget).toBe(12_000 * 4)
  })

  test('never exceeds the 500,000 char hard cap even for a huge context + huge output model', async () => {
    const { computePassCharBudget } = await import('../src/main/agent/memory/compaction')
    const model: ModelInfo = { ...baseModel, contextLength: 10_000_000, maxCompletionTokens: 1_000_000 }
    const budget = computePassCharBudget(model)
    expect(budget).toBeLessThanOrEqual(500_000)
  })

  test('falls back to a conservative default output-token assumption when maxCompletionTokens is unreported', async () => {
    const { computePassCharBudget } = await import('../src/main/agent/memory/compaction')
    const withCap = computePassCharBudget({ ...baseModel, maxCompletionTokens: 8_000 })
    const withoutCap = computePassCharBudget({ ...baseModel, maxCompletionTokens: undefined })
    expect(withoutCap).toBe(withCap) // both use the same 8,000-token conservative default
  })

  test('is bounded by context length for models with a large output cap but small context window', async () => {
    const { computePassCharBudget } = await import('../src/main/agent/memory/compaction')
    const model: ModelInfo = { ...baseModel, contextLength: 8_000, maxCompletionTokens: 100_000 }
    const budget = computePassCharBudget(model)
    // context-driven ceiling: (8000*0.75 - 2000) tokens * 4 = 8000 chars, well under the output-driven one
    expect(budget).toBeLessThan(100_000 * 3 * 4)
  })
})

describe('compactProjectOrGlobalMemory', () => {
  test('returns a no-op result with no backup when there are no existing topics', async () => {
    const { compactProjectOrGlobalMemory } = await import('../src/main/agent/memory/compaction')
    const result = await compactProjectOrGlobalMemory({
      scope: 'project',
      apiKey: 'test-key',
      utilityModel: baseModel.id,
      models: [baseModel],
      workspace: workspaceDir
    })
    expect(result.beforeCount).toBe(0)
    expect(result.afterCount).toBe(0)
    expect(result.passes).toBe(0)
    expect(result.backupPath).toBeNull()
    expect(promptCalls.length).toBe(0)
  })

  test('single pass: parses model output into the new topic set and replaces files on disk', async () => {
    const { writeMemory, listMemoryTopics, readMemoryTopic } = await import('../src/main/agent/memory/manager')
    await writeMemory('project', 'Old feature A', 'Details about feature A.')
    await writeMemory('project', 'Old feature B', 'Details about feature B.')

    promptResponder = () =>
      '### TOPIC: Combined feature A+B\nA merged summary of A and B.\n\n### TOPIC: Leftover note\nSomething else worth keeping.'

    const { compactProjectOrGlobalMemory } = await import('../src/main/agent/memory/compaction')
    const result = await compactProjectOrGlobalMemory({
      scope: 'project',
      apiKey: 'test-key',
      utilityModel: baseModel.id,
      models: [baseModel],
      workspace: workspaceDir
    })

    expect(result.beforeCount).toBe(2)
    expect(result.afterCount).toBe(2)
    expect(result.passes).toBe(1)
    expect(result.backupPath).not.toBeNull()

    const topicsAfter = await listMemoryTopics('project', workspaceDir)
    expect(topicsAfter.sort()).toEqual(['Combined feature A+B', 'Leftover note'])
    expect(await readMemoryTopic('project', 'Combined feature A+B', workspaceDir)).toContain('merged summary')

    // Old topic files should be gone.
    expect(topicsAfter).not.toContain('Old feature A')
    expect(topicsAfter).not.toContain('Old feature B')

    // A backup snapshot should contain the original files.
    const backupFiles = await readdir(result.backupPath!)
    expect(backupFiles.sort()).toEqual(['MEMORY.md', 'Old feature A.md', 'Old feature B.md'].sort())
    expect(await readFile(join(result.backupPath!, 'Old feature A.md'), 'utf8')).toBe('Details about feature A.')
  })

  test('multi-pass: forces multiple passes when the per-pass budget only fits one topic at a time, folding prior output forward', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    await writeMemory('global', 'Topic one', 'x'.repeat(50))
    await writeMemory('global', 'Topic two', 'y'.repeat(50))
    await writeMemory('global', 'Topic three', 'z'.repeat(50))

    // Force a tiny per-pass char budget by using a model with a tiny max-output-token cap, so
    // only one raw topic (~59 chars: "Topic X" + 50 'x's) fits per pass alongside the running
    // compacted state. Budget = maxCompletionTokens * 3 * 4 chars/token = 5 * 3 * 4 = 60 chars.
    const tinyModel: ModelInfo = { ...baseModel, maxCompletionTokens: 5, contextLength: 128_000 }

    let call = 0
    promptResponder = () => {
      call++
      return `### TOPIC: Running summary v${call}\nCompacted so far (pass ${call}).`
    }

    const { compactProjectOrGlobalMemory, computePassCharBudget } = await import('../src/main/agent/memory/compaction')
    const budget = computePassCharBudget(tinyModel)
    expect(budget).toBeGreaterThan(0)

    const result = await compactProjectOrGlobalMemory({
      scope: 'global',
      apiKey: 'test-key',
      utilityModel: tinyModel.id,
      models: [tinyModel],
      workspace: workspaceDir
    })

    expect(result.beforeCount).toBe(3)
    expect(result.passes).toBeGreaterThan(1)
    // Every pass after the first should have included the running/prior-compacted marker text.
    const foldedPasses = promptCalls.filter((c) => c.userContent.includes('Already-compacted notes from earlier'))
    expect(foldedPasses.length).toBe(result.passes - 1)
    // Every pass's prompt should surface the note-count target (1 = round(3 * 1/3)) explicitly,
    // not just a byte-size target, so the model is nudged toward fewer notes throughout the run.
    for (const call of promptCalls) {
      expect(call.userContent).toContain('Progress:')
      expect(call.userContent).toContain('target')
      expect(call.userContent).toContain('about 1 notes')
    }
  })

  test('squeeze pass: runs a follow-up consolidation call when the main loop under-reduces the note count, and accepts an improved result', async () => {
    const { writeMemory, replaceMemoryTopics } = await import('../src/main/agent/memory/manager')
    await replaceMemoryTopics('project', [], workspaceDir) // clear leftover topics from earlier tests in this file
    for (let i = 1; i <= 9; i++) {
      await writeMemory('project', `Topic ${i}`, `Content number ${i}`)
    }

    let call = 0
    promptResponder = () => {
      call++
      if (call === 1) {
        // Main loop pass barely reduces the count: 9 raw notes -> 8 output notes. With
        // targetNoteCount = round(9/3) = 3, this is well over the 1.25x-over-target threshold
        // and should trigger the safety-net squeeze pass.
        return Array.from({ length: 8 }, (_, i) => `### TOPIC: Barely merged ${i + 1}\nContent ${i + 1}`).join('\n\n')
      }
      // Squeeze pass response: consolidate down to the target count.
      return Array.from({ length: 3 }, (_, i) => `### TOPIC: Consolidated ${i + 1}\nMerged content ${i + 1}`).join('\n\n')
    }

    const { compactProjectOrGlobalMemory } = await import('../src/main/agent/memory/compaction')
    const result = await compactProjectOrGlobalMemory({
      scope: 'project',
      apiKey: 'test-key',
      utilityModel: baseModel.id,
      models: [baseModel],
      workspace: workspaceDir
    })

    expect(result.beforeCount).toBe(9)
    expect(result.afterCount).toBe(3)
    expect(result.passes).toBe(2) // one main-loop pass + one squeeze pass
    expect(promptCalls.length).toBe(2)
    expect(promptCalls[1].userContent).toContain('final consolidation pass')
    expect(promptCalls[1].userContent).toContain('about 3 notes')
  })

  test('squeeze pass: skipped entirely when the main loop already lands close to the note-count target', async () => {
    const { writeMemory, replaceMemoryTopics } = await import('../src/main/agent/memory/manager')
    await replaceMemoryTopics('global', [], workspaceDir) // clear leftover topics from earlier tests in this file
    for (let i = 1; i <= 9; i++) {
      await writeMemory('global', `G-Topic ${i}`, `Content number ${i}`)
    }

    // Respond with exactly the target count (3) right away — no consolidation gap to close.
    promptResponder = () => Array.from({ length: 3 }, (_, i) => `### TOPIC: Consolidated ${i + 1}\nMerged content ${i + 1}`).join('\n\n')

    const { compactProjectOrGlobalMemory } = await import('../src/main/agent/memory/compaction')
    const result = await compactProjectOrGlobalMemory({
      scope: 'global',
      apiKey: 'test-key',
      utilityModel: baseModel.id,
      models: [baseModel],
      workspace: workspaceDir
    })

    expect(result.beforeCount).toBe(9)
    expect(result.afterCount).toBe(3)
    expect(result.passes).toBe(1) // no squeeze pass needed
    expect(promptCalls.length).toBe(1)
  })

  test('squeeze pass: rejected (falls back to pre-squeeze result) if it makes the count worse instead of better', async () => {
    const { writeMemory, replaceMemoryTopics } = await import('../src/main/agent/memory/manager')
    await replaceMemoryTopics('project', [], workspaceDir) // clear leftover topics from earlier tests in this file
    for (let i = 1; i <= 9; i++) {
      await writeMemory('project', `Bad-Topic ${i}`, `Content number ${i}`)
    }

    let call = 0
    promptResponder = () => {
      call++
      if (call === 1) {
        // Main pass under-reduces (9 -> 8), triggering a squeeze attempt.
        return Array.from({ length: 8 }, (_, i) => `### TOPIC: Barely merged ${i + 1}\nContent ${i + 1}`).join('\n\n')
      }
      // Misbehaving squeeze pass: grows the count instead of shrinking it (10 > 8).
      return Array.from({ length: 10 }, (_, i) => `### TOPIC: Worse ${i + 1}\nExpanded content ${i + 1}`).join('\n\n')
    }

    const { compactProjectOrGlobalMemory } = await import('../src/main/agent/memory/compaction')
    const result = await compactProjectOrGlobalMemory({
      scope: 'project',
      apiKey: 'test-key',
      utilityModel: baseModel.id,
      models: [baseModel],
      workspace: workspaceDir
    })

    // The squeeze pass ran (2 model calls happened) but its worse-count result should have been
    // discarded, leaving the main loop's 8-note result as the saved outcome.
    expect(promptCalls.length).toBe(2)
    expect(result.afterCount).toBe(8)
  })

  test('throws and leaves disk untouched if a pass returns no usable notes', async () => {
    const { writeMemory, listMemoryTopics } = await import('../src/main/agent/memory/manager')
    await writeMemory('project', 'Topic to keep safe', 'important content')
    promptResponder = () => '   ' // blank/unusable response

    const { compactProjectOrGlobalMemory } = await import('../src/main/agent/memory/compaction')
    await expect(
      compactProjectOrGlobalMemory({
        scope: 'project',
        apiKey: 'test-key',
        utilityModel: baseModel.id,
        models: [baseModel],
        workspace: workspaceDir
      })
    ).rejects.toThrow(/no usable notes/i)

    const topicsAfter = await listMemoryTopics('project', workspaceDir)
    expect(topicsAfter).toContain('Topic to keep safe')
  })

  test('falls back to the first available model when the configured utility model id is not in the catalog', async () => {
    const { writeMemory } = await import('../src/main/agent/memory/manager')
    await writeMemory('global', 'Fallback test topic', 'content here')
    promptResponder = () => '### TOPIC: Kept\nstill here'

    const { compactProjectOrGlobalMemory } = await import('../src/main/agent/memory/compaction')
    const result = await compactProjectOrGlobalMemory({
      scope: 'global',
      apiKey: 'test-key',
      utilityModel: 'nonexistent/model-id',
      models: [baseModel],
      workspace: workspaceDir
    })
    expect(result.passes).toBe(1)
  })
})
