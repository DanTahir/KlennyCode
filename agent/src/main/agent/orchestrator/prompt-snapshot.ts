// Per-conversation freeze of the cached system-prompt prefix.
//
// WHY THIS EXISTS (measured, not theoretical): `buildSystemPrompt()` is called once per agentLoop
// step and re-reads mutable on-disk state every time — project KLENNY.md, global KLENNY.md, the
// auto-memory index, SOUL.md, and the skills/subagents catalogs. Any tool that writes one of those
// files therefore changes the SYSTEM MESSAGE mid-conversation, and because a cached block is keyed
// on its entire preceding prefix, that kills the fixed system breakpoint AND every breakpoint after
// it. The whole conversation gets re-written at the ~1.25x cache-write premium instead of read back
// at ~0.1x.
//
// Observed live in process.log (`[cache]` lines), four mid-session transitions where the `#0:system`
// fingerprint moved while `tools=` stayed byte-identical:
//
//   transition   #0:system chars/wire            result
//   r56 -> r57   82101/33c5faf0 -> 76467/982514ff  cachedTokens=0, cacheWrite= 87 303
//   r67 -> r68   76467/982514ff -> 76821/4ff16dfa  cachedTokens=0, cacheWrite= 89 070
//   r89 -> r90   85757          -> 85937           cachedTokens=0, cacheWrite=122 275
//   r66 -> r67   19955          -> 20226           cachedTokens=0, cacheWrite=188 848
//
// Note the scale mismatch that makes this worth structural enforcement rather than a warning: a
// +180-char memory-index entry re-wrote 122 275 tokens, and a +271-char one re-wrote 188 848. The
// cost is proportional to the CONVERSATION, not to the edit — and it lands late in long sessions,
// which is exactly when the agent saves memory notes. The -5 634 char shrink at r56->r57 is
// auto-memory compaction firing on a write_memory, so a single tool call can move the prefix by
// kilobytes.
//
// THE RULE: the system prompt is built once per conversation and then frozen, exactly like the
// `tools` array (see the update_checklist comment in tools/definitions.ts and the tools-array
// invariant in KLENNY.md). It may only be rebuilt when DELIBERATE, user-initiated configuration
// changes — mode, shell, tab kind, subagent identity, Assistant tool availability — all of which
// are stable for a conversation's life in normal use. Content drift on disk must NEVER rebuild it.
//
// Freshness is not lost, it is relocated: when the on-disk content has drifted, the caller adds a
// short note to the deliberately-uncached TRAILING slot (see buildCurrentTimeNote in
// system-prompt.ts) telling the model the reference block is a snapshot and to re-read via
// list_memory/read_memory/list_skills if it needs current state. The trailing slot is free, so this
// costs nothing in prefix-cache terms — the same reasoning that already puts the clock, the
// verification ledger and the live checklist there.
//
// Kept free of Electron, clocks and module state (the per-tab Map lives in state.ts) so the whole
// decision is directly unit-testable — unit tests cannot observe upstream cache matching, but they
// CAN pin "a disk mutation does not change the bytes we send", which is the half that is ours.

export interface SystemPromptSnapshot {
  /** Fingerprint of the deliberate configuration this prompt was built from. A change here (and
   *  only here) is allowed to rebuild the prefix. */
  configKey: string
  /** The exact prompt string reused on every request for this conversation. */
  prompt: string
}

export interface PromptConfigInput {
  mode: string
  shellId?: string | null
  kind: 'project' | 'assistant'
  subagentType?: string
  subagentBody?: string
  assistantTools?: Record<string, boolean>
}

/**
 * Fingerprints only the inputs a user can deliberately change (mode toggle, shell selection,
 * Assistant tool permissions, subagent identity). Deliberately does NOT include any file content:
 * that omission is the entire point of this module, so do not "improve" this by hashing the built
 * prompt — that would restore the per-step invalidation this exists to prevent.
 *
 * `assistantTools` is serialized key-sorted so an unrelated reordering of that object literal can
 * never look like a configuration change.
 */
export function buildPromptConfigKey(input: PromptConfigInput): string {
  const tools = input.assistantTools
  return JSON.stringify([
    input.mode,
    input.shellId ?? null,
    input.kind,
    input.subagentType ?? null,
    input.subagentBody ?? null,
    tools
      ? Object.keys(tools)
          .sort()
          .map((k) => `${k}=${tools[k] ? 1 : 0}`)
      : null
  ])
}

export interface PromptResolution {
  /** The snapshot to remember for this conversation (unchanged when reused). */
  snapshot: SystemPromptSnapshot
  /** The prompt to actually send — the frozen one whenever the config key still matches. */
  prompt: string
  /** True when on-disk content has drifted from the frozen snapshot, i.e. the model is being sent
   *  a deliberately stale reference block and should be told so via the trailing note. */
  stale: boolean
}

/**
 * Decides what system prompt actually goes on the wire this step.
 *
 * - No snapshot yet, or the deliberate config changed -> adopt `freshPrompt` (and report
 *   `stale: false`; a rebuild is by definition current).
 * - Config unchanged -> reuse the frozen prompt verbatim, and report whether `freshPrompt` would
 *   have differed so the caller can surface that in the uncached trailing note.
 */
export function resolveSystemPrompt(
  existing: SystemPromptSnapshot | undefined,
  configKey: string,
  freshPrompt: string
): PromptResolution {
  if (!existing || existing.configKey !== configKey) {
    return { snapshot: { configKey, prompt: freshPrompt }, prompt: freshPrompt, stale: false }
  }
  return { snapshot: existing, prompt: existing.prompt, stale: freshPrompt !== existing.prompt }
}
