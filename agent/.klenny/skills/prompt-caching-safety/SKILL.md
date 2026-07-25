---
name: prompt-caching-safety
description: Before adding anything to the system prompt or the start of the message array in this codebase, check whether it breaks Anthropic/Qwen-style explicit prompt caching — a real regression that shipped once (see project memory "System prompt caching regression..."). Use this whenever touching buildSystemPrompt, toORMessages, applyCacheControl, or anything that runs on every agent turn.
---

# Prompt caching safety

This app relies on explicit prompt-caching (`cache_control` breakpoints, Anthropic/Qwen-style) to
keep per-turn cost down. It works by resending an **identical** prefix (system prompt + early
messages) on every request — the provider hashes/matches that prefix and skips re-processing it.
The cache breakpoint logic lives in `agent/src/main/openrouter/caching.ts`
(`applyCacheControl`) and only ever marks the *first* system message as the stable breakpoint.

**The failure mode:** any byte that changes between turns inside that cached prefix — a live
timestamp, a random id, a per-call counter, anything computed fresh on every call — silently
turns off caching for the whole prefix, every single turn, with no error and no obvious symptom
in normal use. It just quietly costs more (visible in the UI as `cache-write` on every turn
instead of `... cached (saved $...)`).

## What actually happened (real regression, now fixed)

A "current date/time" note was added so the agent could compute relative/absolute schedule times
without looking things up externally. It was first implemented by folding a freshly-computed
`new Date().toString()` directly into the string returned by `buildSystemPrompt()` — which is the
cached prefix. Because that string is never identical twice, every turn stopped hitting the cache.
See project memory "System prompt caching regression — Current date/time note broke prompt
caching" for the full writeup.

**The fix:** keep the live timestamp completely out of `buildSystemPrompt()`'s return value.
Instead:
- `buildCurrentTimeNote()` (in `agent/src/main/agent/orchestrator/system-prompt.ts`) is a separate
  function computing just that one line.
- `toORMessages()` (in `agent/src/main/agent/messages.ts`) takes it as an optional
  `currentTimeNote` param and appends it as its **own trailing system message**, after the real
  (cacheable) system prompt and after the compaction-summary system message.
- Because `applyCacheControl` only marks the *first* system message as the breakpoint, this
  trailing message rides along uncached each turn without invalidating the big, genuinely static
  prefix (persona, memory, skills/subagent catalogs, workspace path, shell info).

## Checklist before adding anything to the hot prompt path

Ask this before adding *anything* to `buildSystemPrompt()`, `buildAgentModePrompt`/
`buildPlanModePrompt`, or the first N messages sent via `toORMessages`:

1. **Is this value identical across turns within the same session/task run?** If yes (soul text,
   memory notes, skills catalog, workspace path, shell name, subagent catalog) — safe to fold into
   the cached prefix as normal.
2. **Does this value change on every call** (timestamps, random ids, counters, "N tokens used so
   far", anything from `Date.now()`/`Math.random()` computed fresh each time)? If yes — it must
   NOT go into `buildSystemPrompt()`'s return string or anywhere before the cache breakpoint.
   Instead:
   - Compute it separately (its own small function, like `buildCurrentTimeNote()`).
   - Pass it into `toORMessages()`/wherever messages are assembled as its own **trailing** system
     message (or otherwise strictly after the cached breakpoint) — never prepended, never merged
     into the cached string.
3. **If genuinely unsure**, check `agent/src/main/openrouter/caching.ts` to see exactly which
   message `applyCacheControl` marks as the breakpoint (currently: the first system message), and
   make sure your new content lands on the correct side of that line.
4. After the change, sanity-check in the app itself: send two messages in the same chat tab and
   confirm the cost readout under the second one still shows "N cached (saved $...)" rather than
   "cache-write" every time. A permanent switch from cached to cache-write turn-over-turn is the
   signature of this bug.

## Where to look

- `agent/src/main/openrouter/caching.ts` — `applyCacheControl`, the actual breakpoint logic.
- `agent/src/main/agent/messages.ts` — `toORMessages`, where system messages are assembled in
  order; read its doc comment, it explains the ordering contract in detail.
- `agent/src/main/agent/orchestrator/system-prompt.ts` — `buildSystemPrompt` (must stay
  turn-to-turn stable for a given session state) vs. `buildCurrentTimeNote` (deliberately kept
  separate because it's not stable).
