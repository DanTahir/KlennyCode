import { describe, expect, test } from 'bun:test'
import {
  buildPromptConfigKey,
  resolveSystemPrompt,
  type SystemPromptSnapshot
} from '../src/main/agent/orchestrator/prompt-snapshot'

// These tests pin the half of prompt caching that IS observable locally: whether a mutation of
// on-disk memory/skills content changes the bytes we put in the system message mid-conversation.
// Upstream cache matching can only be measured with a live ladder (see the
// caching-live-verification skill), but "the prefix stayed byte-identical" is ours to guarantee.

const CONFIG = {
  mode: 'agent',
  shellId: 'git-bash',
  kind: 'project' as const
}

describe('resolveSystemPrompt — freezing the prefix for a conversation', () => {
  test('adopts the fresh prompt when there is no snapshot yet', () => {
    const key = buildPromptConfigKey(CONFIG)
    const res = resolveSystemPrompt(undefined, key, 'PROMPT V1')

    expect(res.prompt).toBe('PROMPT V1')
    expect(res.stale).toBe(false)
    expect(res.snapshot).toEqual({ configKey: key, prompt: 'PROMPT V1' })
  })

  test('reuses the frozen prompt and stays non-stale when disk content has not moved', () => {
    const key = buildPromptConfigKey(CONFIG)
    const existing: SystemPromptSnapshot = { configKey: key, prompt: 'PROMPT V1' }
    const res = resolveSystemPrompt(existing, key, 'PROMPT V1')

    expect(res.prompt).toBe('PROMPT V1')
    expect(res.stale).toBe(false)
    expect(res.snapshot).toBe(existing)
  })

  test('THE REGRESSION: a mid-conversation disk mutation does NOT change the prompt we send', () => {
    // This is the write_memory / write_skill / KLENNY.md-edit case that was measured re-writing
    // up to 188 848 tokens in one request. The freshly-built prompt differs, but the bytes on the
    // wire must not, or the fixed system breakpoint (and every breakpoint after it) dies.
    const key = buildPromptConfigKey(CONFIG)
    const existing: SystemPromptSnapshot = { configKey: key, prompt: 'PROMPT V1' }
    const res = resolveSystemPrompt(existing, key, 'PROMPT V1 + a new auto-memory index entry')

    expect(res.prompt).toBe('PROMPT V1')
    expect(res.snapshot.prompt).toBe('PROMPT V1')
    // ...but the drift is reported, so the caller can say so in the uncached trailing note.
    expect(res.stale).toBe(true)
  })

  test('rebuilds when a DELIBERATE config change happens (shell switch)', () => {
    const existing: SystemPromptSnapshot = {
      configKey: buildPromptConfigKey(CONFIG),
      prompt: 'PROMPT V1'
    }
    const newKey = buildPromptConfigKey({ ...CONFIG, shellId: 'powershell' })
    const res = resolveSystemPrompt(existing, newKey, 'PROMPT V2')

    expect(res.prompt).toBe('PROMPT V2')
    expect(res.stale).toBe(false)
    expect(res.snapshot.configKey).toBe(newKey)
  })

  test('rebuilds on a mode switch (agent <-> plan), which changes the whole persona body', () => {
    const existing: SystemPromptSnapshot = {
      configKey: buildPromptConfigKey(CONFIG),
      prompt: 'AGENT PROMPT'
    }
    const newKey = buildPromptConfigKey({ ...CONFIG, mode: 'plan' })
    const res = resolveSystemPrompt(existing, newKey, 'PLAN PROMPT')

    expect(res.prompt).toBe('PLAN PROMPT')
    expect(res.stale).toBe(false)
  })
})

describe('buildPromptConfigKey', () => {
  test('is stable across repeated calls with equal input', () => {
    expect(buildPromptConfigKey(CONFIG)).toBe(buildPromptConfigKey(CONFIG))
  })

  test('ignores key ORDER in assistantTools (a reordered literal is not a config change)', () => {
    const a = buildPromptConfigKey({
      ...CONFIG,
      kind: 'assistant',
      assistantTools: { docx: true, gmailRead: false, browser: true }
    })
    const b = buildPromptConfigKey({
      ...CONFIG,
      kind: 'assistant',
      assistantTools: { browser: true, docx: true, gmailRead: false }
    })
    expect(a).toBe(b)
  })

  test('moves when any deliberate input changes', () => {
    const base = buildPromptConfigKey({ ...CONFIG, kind: 'assistant', assistantTools: { docx: false } })
    expect(buildPromptConfigKey({ ...CONFIG, kind: 'project', assistantTools: { docx: false } })).not.toBe(base)
    expect(buildPromptConfigKey({ ...CONFIG, kind: 'assistant', assistantTools: { docx: true } })).not.toBe(base)
    expect(
      buildPromptConfigKey({ ...CONFIG, kind: 'assistant', assistantTools: { docx: false }, subagentType: 'explore' })
    ).not.toBe(base)
    expect(
      buildPromptConfigKey({ ...CONFIG, kind: 'assistant', assistantTools: { docx: false }, subagentBody: 'do x' })
    ).not.toBe(base)
  })

  test('NEGATIVE CONTROL: the key is not derived from prompt content, so content drift cannot move it', () => {
    // If a future change hashed the built prompt into the key, the freeze would silently stop
    // working and every disk write would invalidate the cache again. Two identical configs must
    // produce one key regardless of what the prompt text happens to be.
    const key = buildPromptConfigKey(CONFIG)
    const first = resolveSystemPrompt(undefined, key, 'PROMPT A')
    const second = resolveSystemPrompt(first.snapshot, buildPromptConfigKey(CONFIG), 'PROMPT B')
    expect(second.prompt).toBe('PROMPT A')
    expect(second.stale).toBe(true)
  })
})
